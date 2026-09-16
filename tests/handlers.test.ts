// tests/handlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { loadConfig } from '../src/config.js'
import { handlePlex, handlePulsarr } from '../src/handlers.js'
import { createGate } from '../src/outbox.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
let store: Store
beforeEach(() => { store = openStore(':memory:') })

const CONFIG = loadConfig({
  BINGERS_SESSION_COOKIE: 'TOK', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt', ALLOWED_USER: 'testuser', DRY_RUN: 'false',
} as NodeJS.ProcessEnv)

let n = 0
const newId = () => `id-${++n}`

type Body = unknown | ((init: any) => unknown)

function router(routes: [RegExp, Body][]) {
  const calls: { url: string; init?: any }[] = []
  const f = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    for (const [re, body] of routes) {
      if (!re.test(url)) continue
      const b = typeof body === 'function' ? (body as (i: any) => unknown)(init) : body
      return new Response(JSON.stringify(b), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
  return { f, calls }
}

// The real /sync/push reports per-op status. The previous stub returned
// `{ results: [] }` -- i.e. "the server applied NOTHING" -- while every test
// asserted status 'ok', which encoded the discarded-results defect as expected
// behaviour. Echo the posted ops as applied, which is what a healthy server
// does, and stub rejection explicitly where that is what is under test.
const pushEcho = (init: any) => ({
  results: (init?.body ? JSON.parse(init.body).ops : []).map((o: any) => ({ opId: o.opId, status: 'applied' })),
  rows: {},
})

const SCROBBLE = {
  user: 'testuser', type: 'episode' as const, showRatingKey: '90363',
  guids: [{ id: 'tmdb://5175711' }], grandparentTitle: 'Tires', title: 'Sales Contest',
  year: 2024, season: 1, number: 3, viewCount: 1, lastViewedAt: 1789553428,
}

const ROUTES: [RegExp, Body][] = [
  [/library\/metadata\/90363\?includeGuids/, { MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://247522' }] }] } }],
  [/allLeaves/, { MediaContainer: { Metadata: [
    // viewCount deliberately differs from SCROBBLE's (1): if the backfill op
    // ever carried the scrobble's plays instead of this leaf's own, a test
    // asserting plays===1 here would pass by coincidence and miss the bug.
    { parentIndex: 1, index: 1, viewCount: 3, lastViewedAt: 1788000000 },
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
  [/sync\/push/, pushEcho],
]

const deps = (f: any) => ({ config: CONFIG, store, auth: createAuth(store, 'TOK', 'UA'), gate: createGate(), fetchImpl: f as typeof fetch, newId })

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
    store.markMirrorSynced() // backfill requires a fresh mirror -- see the C1 tests below
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    const push = calls.find(c => /sync\/push/.test(c.url))!
    const ops = JSON.parse(push.init.body).ops
    const ids = ops.filter((o: any) => o.table === 'entries').map((o: any) => o.pk.entityId)
    // E3 scrobbled, E1 watched in plex; E2 has viewCount 0 and must be absent
    expect(ids).toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f117')
    expect(ids).toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
    expect(ids).not.toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f111')

    // E1's backfill entry must carry ITS OWN plays/date from the allLeaves
    // stub (viewCount 3, lastViewedAt 1788000000), not the scrobble's
    // (viewCount 1, lastViewedAt 1789553428). Pins iso()'s unix-seconds unit:
    // if iso() were changed to treat the value as milliseconds, this exact
    // string would no longer match.
    const e1Op = ops.find((o: any) => o.table === 'entries' && o.pk.entityId === '019f6bb9-65fd-7ef3-8053-8e3333a9f110')
    expect(e1Op.fields.plays).toBe(3)

    const e1Patch = calls.find(c =>
      /me\/watches\//.test(c.url) && c.init?.method === 'PATCH' &&
      JSON.parse(c.init.body).entityId === '019f6bb9-65fd-7ef3-8053-8e3333a9f110')!
    expect(JSON.parse(e1Patch.init.body).watchedAt).toBe('2026-08-29T10:40:00.000Z')
  })

  it('does not re-write an episode already watched on bingers', async () => {
    store.markMirrorSynced()
    store.putSyncRows('entries', [{ pk: 'episode:019f6bb9-65fd-7ef3-8053-8e3333a9f110', row: { watched: true, deletedAt: null } }])
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    const ids = ops.filter((o: any) => o.table === 'entries').map((o: any) => o.pk.entityId)
    expect(ids).not.toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
  })

  it('re-follows a title the user had removed', async () => {
    // A follows row with deletedAt set means the user removed this title.
    // isFollowed() must treat that as NOT followed, so the scrobble still
    // emits a follow op — matching the app's own "add to your list?" prompt.
    store.putSyncRows('follows', [{
      pk: '019f6bb9-65cf-78d1-b123-f9ed891fe9d7',
      row: { titleId: '019f6bb9-65cf-78d1-b123-f9ed891fe9d7', kind: 'show', deletedAt: '2026-09-01T00:00:00.000Z' },
    }])
    const { f, calls } = router(ROUTES)
    const r = await handlePlex(deps(f), SCROBBLE)
    expect(r.status).toBe('ok')
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    expect(ops.some((o: any) => o.table === 'follows' && o.pk.titleId === '019f6bb9-65cf-78d1-b123-f9ed891fe9d7')).toBe(true)
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

const entryIds = (calls: { url: string; init?: any }[]) =>
  JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    .filter((o: any) => o.table === 'entries').map((o: any) => o.pk.entityId)

const SCROBBLED_EP = '019f6bb9-65fd-7ef3-8053-8e3333a9f117'
const BACKFILL_EP = '019f6bb9-65fd-7ef3-8053-8e3333a9f110'

// C1 -- backfill must not degrade to "write everything" when the boot pull failed.
describe('handlePlex backfill guard (mirror freshness)', () => {
  it('skips backfill when the mirror has never synced, but still writes the scrobbled episode', async () => {
    // Default state: no successful sync/pull has ever run, so sync_state is
    // empty. Without the guard, alreadyWatched() returns false for EVERY
    // episode and the whole show is pushed and re-dated.
    const { f, calls } = router(ROUTES)
    const r = await handlePlex(deps(f), SCROBBLE)
    expect(r.status).toBe('ok')
    expect(entryIds(calls)).toEqual([SCROBBLED_EP])
  })

  it('records a visible failures row explaining that backfill was skipped', async () => {
    const { f } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    const reasons = store.listFailures().map(x => x.reason)
    expect(reasons.some(x => /backfill skipped/.test(x))).toBe(true)
    expect(reasons.some(x => /never succeeded/.test(x))).toBe(true)
  })

  it('skips backfill when the last successful pull is older than twice the pull interval', async () => {
    // syncPullIntervalMin defaults to 30, so anything past 60 minutes is stale.
    store.markMirrorSynced(new Date(Date.now() - 61 * 60_000).toISOString())
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    expect(entryIds(calls)).toEqual([SCROBBLED_EP])
    expect(store.listFailures().some(x => /backfill skipped/.test(x.reason))).toBe(true)
  })

  it('backfills normally while the mirror is inside the freshness window', async () => {
    store.markMirrorSynced(new Date(Date.now() - 5 * 60_000).toISOString())
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    expect(entryIds(calls)).toContain(BACKFILL_EP)
    expect(store.listFailures().some(x => /backfill skipped/.test(x.reason))).toBe(false)
  })
})

// M7 / M8 -- nothing non-finite and nothing undated may reach the wire.
describe('handlePlex leaf hygiene', () => {
  it('defaults plays to 1 when plex sends a non-numeric viewCount instead of serialising null', async () => {
    store.markMirrorSynced()
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), { ...SCROBBLE, viewCount: Number('not-a-number') })
    const body = calls.find(c => /sync\/push/.test(c.url))!.init.body
    expect(body).not.toContain('"plays":null')
    const op = JSON.parse(body).ops.find((o: any) => o.pk?.entityId === SCROBBLED_EP)
    expect(op.fields.plays).toBe(1)
  })

  it('excludes a backfill leaf with a non-finite viewCount rather than letting NaN through the <1 filter', async () => {
    store.markMirrorSynced()
    const { f, calls } = router([
      [/allLeaves/, { MediaContainer: { Metadata: [
        { parentIndex: 1, index: 1, viewCount: 'lots', lastViewedAt: 1788000000 },
        { parentIndex: 1, index: 3, viewCount: 1, lastViewedAt: 1789553428 },
      ] } }],
      ...ROUTES,
    ])
    await handlePlex(deps(f), SCROBBLE)
    expect(entryIds(calls)).toEqual([SCROBBLED_EP])
  })

  it('excludes a backfill leaf with no lastViewedAt rather than inventing today as its watch date', async () => {
    store.markMirrorSynced()
    const { f, calls } = router([
      [/allLeaves/, { MediaContainer: { Metadata: [
        { parentIndex: 1, index: 1, viewCount: 2 }, // watched, but plex has no timestamp
        { parentIndex: 1, index: 3, viewCount: 1, lastViewedAt: 1789553428 },
      ] } }],
      ...ROUTES,
    ])
    await handlePlex(deps(f), SCROBBLE)
    expect(entryIds(calls)).not.toContain(BACKFILL_EP)
    expect(entryIds(calls)).toEqual([SCROBBLED_EP])
  })
})

// I2 -- a 200 whose per-op results reject an entry must not read as 'sent'.
describe('handlePlex honours per-op push results', () => {
  const rejectAll = () => ({
    results: [] as { opId: string; status: string }[], rows: {},
  })

  it('queues unconfirmed ops and records the shortfall instead of silently dropping them', async () => {
    store.markMirrorSynced()
    // Overrides go FIRST: router() returns the first matching route.
    const { f } = router([[/sync\/push/, rejectAll], ...ROUTES])
    const r = await handlePlex(deps(f), SCROBBLE)
    expect(r.status).toBe('ok') // still 200-shaped for plex
    expect(store.outboxDepth()).toBeGreaterThan(0)
    expect(store.listFailures().some(x => /bingers confirmed 0\//.test(x.reason))).toBe(true)
  })

  it('keeps a partially rejected op for retry while the confirmed one is done', async () => {
    store.markMirrorSynced()
    const partial = (init: any) => {
      const ops = JSON.parse(init.body).ops
      return { results: ops.slice(0, 1).map((o: any) => ({ opId: o.opId, status: 'applied' })), rows: {} }
    }
    const { f } = router([[/sync\/push/, partial], ...ROUTES])
    await handlePlex(deps(f), SCROBBLE)
    const pushed = JSON.parse((f as any).mock.calls.find((c: any[]) => /sync\/push/.test(c[0]))[1].body).ops
    expect(store.outboxDepth()).toBe(pushed.length - 1)
  })
})

// Binge behaviour: a confirmed write is mirrored locally at once, rather than
// waiting up to SYNC_PULL_INTERVAL_MIN for the next pull to reveal it.
describe('optimistic local mirror', () => {
  it('does not re-push an episode a previous scrobble already wrote', async () => {
    store.markMirrorSynced()
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    expect(entryIds(calls)).toContain(BACKFILL_EP)

    // Second scrobble of the same show, mirror not refreshed in between.
    const second = router(ROUTES)
    await handlePlex(deps(second.f), { ...SCROBBLE, number: 1, lastViewedAt: 1788000000 })
    const ids = entryIds(second.calls)
    expect(ids).not.toContain(SCROBBLED_EP)
  })

  it('marks a confirmed follow so the next scrobble does not re-follow', async () => {
    store.markMirrorSynced()
    const { f } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    const second = router(ROUTES)
    await handlePlex(deps(second.f), SCROBBLE)
    const ops = JSON.parse(second.calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    expect(ops.some((o: any) => o.table === 'follows')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Task 15 -- PLEX_ALLLEAVES_TTL_MIN. The scrobbled episode is ALWAYS written;
// only the backfill scan is rate limited.
// ---------------------------------------------------------------------------
const E2 = '019f6bb9-65fd-7ef3-8053-8e3333a9f111'
const RK = '90363'
const calledAllLeaves = (calls: { url: string }[]) => calls.some(c => /allLeaves/.test(c.url))

describe('handlePlex allLeaves rate limit', () => {
  it('makes no second allLeaves call inside the TTL, and still writes the scrobbled episode', async () => {
    store.markMirrorSynced()
    const first = router(ROUTES)
    await handlePlex(deps(first.f), SCROBBLE)
    expect(calledAllLeaves(first.calls)).toBe(true)

    // Same show, seconds later: PLEX_ALLLEAVES_TTL_MIN defaults to 60.
    const second = router(ROUTES)
    const r = await handlePlex(deps(second.f), { ...SCROBBLE, number: 2, lastViewedAt: 1789553500 })
    expect(r.status).toBe('ok')
    expect(calledAllLeaves(second.calls)).toBe(false)
    expect(entryIds(second.calls)).toEqual([E2]) // the scrobble itself still lands
  })

  it('fetches again once the TTL has elapsed', async () => {
    store.markMirrorSynced()
    const first = router(ROUTES)
    await handlePlex(deps(first.f), SCROBBLE)
    store.markAllLeavesFetched(RK, new Date(Date.now() - 61 * 60_000).toISOString())

    const second = router(ROUTES)
    await handlePlex(deps(second.f), { ...SCROBBLE, number: 2, lastViewedAt: 1789553500 })
    expect(calledAllLeaves(second.calls)).toBe(true)
  })

  it('skips allLeaves for a fully reconciled show even long after the TTL has elapsed', async () => {
    store.markMirrorSynced()
    // E1 is the only other episode plex reports watched, and bingers already
    // has it -- so after this run nothing plex knows is missing from bingers.
    store.putSyncRows('entries', [{ pk: `episode:${BACKFILL_EP}`, row: { watched: true, deletedAt: null } }])
    const first = router(ROUTES)
    await handlePlex(deps(first.f), SCROBBLE)
    expect(calledAllLeaves(first.calls)).toBe(true)
    expect(store.getAllLeavesState(RK).reconciledAt).not.toBeNull()

    // A day later: the TTL alone would happily permit another scan.
    store.markAllLeavesFetched(RK, new Date(Date.now() - 24 * 60 * 60_000).toISOString())
    const second = router(ROUTES)
    await handlePlex(deps(second.f), { ...SCROBBLE, number: 2, lastViewedAt: 1789553500 })
    expect(calledAllLeaves(second.calls)).toBe(false)
    expect(entryIds(second.calls)).toEqual([E2])
  })

  it('does not call a show reconciled while plex reports a watch bingers has not got', async () => {
    store.markMirrorSynced()
    const { f } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE) // E1 is backfilled by THIS run, not already present
    expect(store.getAllLeavesState(RK).reconciledAt).toBeNull()
    expect(store.getAllLeavesState(RK).fetchedAt).not.toBeNull()
  })

  it('records no fetch marker when the allLeaves call itself failed, so the next scrobble retries', async () => {
    store.markMirrorSynced()
    const { f } = router(ROUTES)
    const failing = vi.fn(async (url: string, init?: any) =>
      /allLeaves/.test(url) ? new Response('nope', { status: 503 }) : f(url, init))
    await handlePlex(deps(failing), SCROBBLE)
    expect(store.getAllLeavesState(RK)).toEqual({ fetchedAt: null, reconciledAt: null })

    const second = router(ROUTES)
    await handlePlex(deps(second.f), { ...SCROBBLE, number: 2, lastViewedAt: 1789553500 })
    expect(calledAllLeaves(second.calls)).toBe(true)
  })

  it('still skips backfill on a stale mirror even when the TTL would permit a fetch', async () => {
    // allLeaves has never been fetched for this show, so the TTL imposes no
    // skip of its own and would wave the scan straight through. The mirror
    // guard is the only thing standing between this scrobble and a whole-show
    // re-date, and it has to win -- and keep saying so out loud.
    store.markMirrorSynced(new Date(Date.now() - 61 * 60_000).toISOString())
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    expect(calledAllLeaves(calls)).toBe(false)
    expect(entryIds(calls)).toEqual([SCROBBLED_EP])
    expect(store.listFailures().some(x => /backfill skipped/.test(x.reason))).toBe(true)
    // ...and nothing about the suppressed scan may be recorded as if it ran.
    expect(store.getAllLeavesState(RK)).toEqual({ fetchedAt: null, reconciledAt: null })
  })
})

describe('handlePulsarr', () => {
  it('follows on added using the verified titleId', async () => {
    const { f, calls } = router([
      [/search\/titles/, { results: [{ id: 'M1', kind: 'show', metadata: 'h', card: { originalTitle: 'The Mentalist', titlesI18n: {}, year: 2008 } }] }],
      [/metadata@h/, { id: 'M1', title: 'The Mentalist', year: 2008, kind: 'show', external_ids: [{ id: '5920', source: 'tmdb' }] }],
      [/sync\/push/, pushEcho],
    ])
    const r = await handlePulsarr(deps(f), {
      user: 'testuser', action: 'added', title: 'The Mentalist', kind: 'show', guids: [{ id: 'tmdb://5920' }],
    })
    expect(r.status).toBe('ok')
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    expect(ops[0]).toMatchObject({ table: 'follows', pk: { titleId: 'M1' }, fields: { kind: 'show' } })
  })

  it('uses op-level deleted on removed', async () => {
    store.putTitleMapping([{ source: 'tmdb', extId: '5920', kind: 'show', titleId: 'M1', title: null, year: null }])
    const { f, calls } = router([[/sync\/push/, pushEcho]])
    await handlePulsarr(deps(f), {
      user: 'testuser', action: 'removed', title: 'The Mentalist', kind: 'show', guids: [{ id: 'tmdb://5920' }],
    })
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    expect(ops[0].deleted).toBe(true)
    expect(ops[0].fields).toBeUndefined()
  })
})
