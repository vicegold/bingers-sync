import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { resolveEpisode } from '../src/resolve.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
let store: Store
beforeEach(() => { store = openStore(':memory:') })

function routed(routes: Record<string, unknown>, counter?: { n: number }) {
  return vi.fn(async (url: string) => {
    if (counter) counter.n++
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
}

const ROUTES = {
  'versions.json': fx('versions-tires'),
  'season-1@dddd00000004.json': fx('season1-tires'),
  'season-0@cccc00000003.json': { episodes: [{ n: 1, abs: 0, id: 'SPECIAL1', title: 'Behind the scenes', aired: '2024-05-01' }] },
}
const deps = (f: any) => ({ store, fetchImpl: f as typeof fetch, searchMaxPages: 1, catalogTtlHours: 24 })

describe('resolveEpisode', () => {
  it('resolves a season/number pair to the bingers episode id', async () => {
    const r = await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 1, number: 3 })
    expect(r).toEqual({ episodeId: '019f6bb9-65fd-7ef3-8053-8e3333a9f117' })
  })

  it('hydrates every season on first resolution, including season 0', async () => {
    await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 1, number: 3 })
    expect(store.getEpisodeId('T1', 1, 1)).toBe('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
    expect(store.getEpisodeId('T1', 0, 1)).toBe('SPECIAL1')
  })

  it('makes no network calls at all on a second episode of the same show', async () => {
    const c = { n: 0 }
    const f = routed(ROUTES, c)
    await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 3 })
    const afterFirst = c.n
    expect(afterFirst).toBeGreaterThan(0)
    await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 1 })
    expect(c.n).toBe(afterFirst)
  })

  it('fails cleanly for an episode the catalog does not have', async () => {
    const r = await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 9, number: 9 })
    expect(r).toHaveProperty('failure')
  })

  it('re-hydrates when an episode is missing, picking up a newly aired one', async () => {
    const f1 = routed(ROUTES)
    await resolveEpisode(deps(f1), { titleId: 'T1', season: 1, number: 3 })

    const grown = { episodes: [...fx('season1-tires').episodes, { n: 4, abs: 4, id: 'NEW4', title: 'New', aired: '2026-01-01' }] }
    const f2 = routed({
      'versions.json': { titleId: 'T1', kind: 'show', files: { metadata: 'm', seasons: { '0': 'cccc00000003', '1': 'HASHCHANGED' } } },
      'season-1@HASHCHANGED.json': grown,
      'season-0@cccc00000003.json': ROUTES['season-0@cccc00000003.json'],
    })
    const r = await resolveEpisode(deps(f2), { titleId: 'T1', season: 1, number: 4 })
    expect(r).toEqual({ episodeId: 'NEW4' })
  })
})
