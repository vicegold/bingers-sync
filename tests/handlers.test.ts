// tests/handlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { loadConfig } from '../src/config.js'
import { handlePlex, handlePulsarr } from '../src/handlers.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
let store: Store
beforeEach(() => { store = openStore(':memory:') })

const CONFIG = loadConfig({
  BINGERS_SESSION_COOKIE: 'TOK', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt', DRY_RUN: 'false',
} as NodeJS.ProcessEnv)

let n = 0
const newId = () => `id-${++n}`

function router(routes: [RegExp, unknown][]) {
  const calls: { url: string; init?: any }[] = []
  const f = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    for (const [re, body] of routes) if (re.test(url)) return new Response(JSON.stringify(body), { status: 200 })
    return new Response('{}', { status: 404 })
  })
  return { f, calls }
}

const SCROBBLE = {
  user: 'plexuser', type: 'episode' as const, showRatingKey: '90363',
  guids: [{ id: 'tmdb://5175711' }], grandparentTitle: 'Tires', title: 'Sales Contest',
  year: 2024, season: 1, number: 3, viewCount: 1, lastViewedAt: 1789553428,
}

const ROUTES: [RegExp, unknown][] = [
  [/library\/metadata\/90363\?includeGuids/, { MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://247522' }] }] } }],
  [/allLeaves/, { MediaContainer: { Metadata: [
    { parentIndex: 1, index: 1, viewCount: 1, lastViewedAt: 1788000000 },
    { parentIndex: 1, index: 2 },
    { parentIndex: 1, index: 3, viewCount: 1, lastViewedAt: 1789553428 },
  ] } }],
  [/search\/titles/, fx('search-tires')],
  [/metadata@543408442fd2/, fx('metadata-tires')],
  [/versions\.json/, fx('versions-tires')],
  [/season-1@dddd00000004/, fx('season1-tires')],
  [/season-0@cccc00000003/, { episodes: [] }],
  [/me\/watches\?/, { watches: [{ id: 'w1', watchedAt: '2026-09-16T12:00:00.000Z' }] }],
  [/me\/watches\//, { entry: {} }],
  [/sync\/push/, { results: [], rows: {} }],
]

const deps = (f: any) => ({ config: CONFIG, store, auth: createAuth(store, 'TOK', 'UA'), fetchImpl: f as typeof fetch, newId })

describe('handlePlex', () => {
  it('ignores a scrobble from another user without writing', async () => {
    const { f } = router(ROUTES)
    const r = await handlePlex(deps(f), { ...SCROBBLE, user: 'someone-else' })
    expect(r.status).toBe('ignored')
    expect(f).not.toHaveBeenCalled()
  })

  it('resolves via the SHOW ids from plex, not the episode guids in the payload', async () => {
    const { f, calls } = router(ROUTES)
    const r = await handlePlex(deps(f), SCROBBLE)
    expect(r.status).toBe('ok')
    expect(calls.some(c => /library\/metadata\/90363\?includeGuids/.test(c.url))).toBe(true)
  })

  it('pushes the scrobbled episode and only plex-watched backfill episodes', async () => {
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    const push = calls.find(c => /sync\/push/.test(c.url))!
    const ops = JSON.parse(push.init.body).ops
    const ids = ops.filter((o: any) => o.table === 'entries').map((o: any) => o.pk.entityId)
    // E3 scrobbled, E1 watched in plex; E2 has viewCount 0 and must be absent
    expect(ids).toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f117')
    expect(ids).toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
    expect(ids).not.toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f111')
  })

  it('does not re-write an episode already watched on bingers', async () => {
    store.putSyncRows('entries', [{ pk: 'episode:019f6bb9-65fd-7ef3-8053-8e3333a9f110', row: { watched: true, deletedAt: null } }])
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    const ids = ops.filter((o: any) => o.table === 'entries').map((o: any) => o.pk.entityId)
    expect(ids).not.toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
  })

  it('records a failure and returns 200-shaped ok when nothing verifies', async () => {
    const { f } = router([
      [/library\/metadata\/90363\?includeGuids/, { MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://000' }] }] } }],
      [/search\/titles/, fx('search-tires')],
      [/metadata@543408442fd2/, fx('metadata-tires')],
    ])
    const r = await handlePlex(deps(f), SCROBBLE)
    expect(r.status).toBe('failed')
    expect(store.listFailures()).toHaveLength(1)
  })
})

describe('handlePulsarr', () => {
  it('follows on added using the verified titleId', async () => {
    const { f, calls } = router([
      [/search\/titles/, { results: [{ id: 'M1', kind: 'show', metadata: 'h', card: { originalTitle: 'The Mentalist', titlesI18n: {}, year: 2008 } }] }],
      [/metadata@h/, { id: 'M1', title: 'The Mentalist', year: 2008, kind: 'show', external_ids: [{ id: '5920', source: 'tmdb' }] }],
      [/sync\/push/, { results: [], rows: {} }],
    ])
    const r = await handlePulsarr(deps(f), {
      user: 'plexuser', action: 'added', title: 'The Mentalist', kind: 'show', guids: [{ id: 'tmdb://5920' }],
    })
    expect(r.status).toBe('ok')
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    expect(ops[0]).toMatchObject({ table: 'follows', pk: { titleId: 'M1' }, fields: { kind: 'show' } })
  })

  it('uses op-level deleted on removed', async () => {
    store.putTitleMapping([{ source: 'tmdb', extId: '5920', kind: 'show', titleId: 'M1', title: null, year: null }])
    const { f, calls } = router([[/sync\/push/, { results: [], rows: {} }]])
    await handlePulsarr(deps(f), {
      user: 'plexuser', action: 'removed', title: 'The Mentalist', kind: 'show', guids: [{ id: 'tmdb://5920' }],
    })
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    expect(ops[0].deleted).toBe(true)
    expect(ops[0].fields).toBeUndefined()
  })
})
