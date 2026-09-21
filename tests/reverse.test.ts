import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { loadConfig } from '../src/config.js'
import { reconcileWatchlist, reverseBackoffMs, reverseDeferBackoffMs } from '../src/reverse.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

// REVERSE_SYNC is opt-in (it defaults to off), so every test that expects the
// reconcile to do anything has to ask for it explicitly.
const cfg = (over: Record<string, string> = {}) => loadConfig({
  BINGERS_SESSION_COOKIE: 'c', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt',
  ALLOWED_USER: 'testuser', DRY_RUN: 'false', REVERSE_SYNC: 'true', ...over,
} as NodeJS.ProcessEnv)

// NOTE: title_map's primary key is (source, ext_id, kind). Giving two titles the
// same extId would make the second overwrite the first, and externalIdsFor would
// then return {} for the first — so each follow gets its own id.
let extSeq = 0
function follow(titleId: string, extId = `592${extSeq++}`) {
  store.putSyncRows('follows', [{ pk: titleId, row: { titleId, kind: 'show', deletedAt: null } }])
  store.putTitleMapping([{ source: 'tmdb', extId, kind: 'show', titleId, title: 'The Mentalist', year: 2008 }])
  return extId
}

// Third element is an optional HTTP status (default 200), so a route can
// simulate a single bad candidate (e.g. a 500 or 429) without failing every
// request that matches a broader route.
function router(routes: [RegExp, unknown, number?][]) {
  const calls: { url: string; init?: any }[] = []
  // Every reconcile with something to add first reads the watchlist, to tell
  // "we put this here" from "it was already there". Default it to empty so
  // tests about adding stay about adding; routes are matched in order, so a
  // test that cares supplies its own entry ahead of this one.
  const all: [RegExp, unknown, number?][] = [...routes,
    [/sections\/watchlist\/all/, { MediaContainer: { totalSize: 0, Metadata: [] } }]]
  const f = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    for (const [re, body, status] of all) if (re.test(url)) return new Response(JSON.stringify(body), { status: status ?? 200 })
    return new Response('{}', { status: 404 })
  })
  return { f, calls }
}

const SEARCH_HIT: [RegExp, unknown] = [/library\/search/, { MediaContainer: { SearchResults: [{ SearchResult: [
  { Metadata: { guid: 'plex://show/RIGHT', title: 'The Mentalist', year: 2008 } },
] }] } }]
const IDS_MATCH: [RegExp, unknown] = [/metadata\/RIGHT/, { MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://5920' }] }] } }]
const ADD_OK: [RegExp, unknown] = [/addToWatchlist/, {}]
const NOTIFY = 'http://notify.test/hook'

// sync_state.updated_at has millisecond resolution, so rows written in the same
// millisecond sort arbitrarily. Burn one so the next write sorts strictly after.
function tick() { const t = Date.now(); while (Date.now() === t) { /* spin */ } }

describe('reverseBackoffMs', () => {
  it('grows from an hour and caps at a week', () => {
    expect(reverseBackoffMs(0)).toBe(3_600_000)
    expect(reverseBackoffMs(2)).toBe(14_400_000)
    expect(reverseBackoffMs(99)).toBe(604_800_000)
  })
})

describe('reconcileWatchlist', () => {
  it('adds a followed title whose discover guids intersect', async () => {
    const id = follow('T1')
    const { f, calls } = router([SEARCH_HIT,
      [/metadata\/RIGHT/, { MediaContainer: { Metadata: [{ Guid: [{ id: `tmdb://${id}` }] }] } }],
      ADD_OK])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.added).toBe(1)
    expect(calls.some(c => /addToWatchlist\?ratingKey=RIGHT/.test(c.url))).toBe(true)
    expect(store.getPlexLink('T1')).toMatchObject({ ratingKey: 'RIGHT', state: 'added' })
  })

  it('REFUSES a candidate whose guids do not intersect, and records it', async () => {
    follow('T1')
    const { f, calls } = router([
      SEARCH_HIT,
      [/metadata\/RIGHT/, { MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://999999' }] }] } }],
      ADD_OK,
    ])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.added).toBe(0)
    expect(r.unresolved).toBe(1)
    expect(calls.some(c => /addToWatchlist/.test(c.url))).toBe(false)
    expect(store.getPlexLink('T1')).toMatchObject({ state: 'unresolved', attempts: 1 })
    expect(store.listFailures()).toHaveLength(1)
  })

  it('never writes under dry run', async () => {
    follow('T1')
    const { f, calls } = router([SEARCH_HIT, IDS_MATCH, ADD_OK])
    const r = await reconcileWatchlist({ config: cfg({ DRY_RUN: 'true' }), store, fetchImpl: f as any })
    expect(calls.some(c => /addToWatchlist/.test(c.url))).toBe(false)
    expect(r.added).toBe(0)
    expect(store.getPlexLink('T1')).toBeNull() // nothing recorded, so a real run still picks it up
    // DRY_RUN is checked BEFORE any discover traffic -- a dry run must cost
    // Plex nothing, not just skip the write at the end.
    expect(f).not.toHaveBeenCalled()
  })

  it('does not abort the whole candidate loop when one candidate errors, and finds a later match', async () => {
    const id = follow('T1')
    const SEARCH_THREE: [RegExp, unknown] = [/library\/search/, { MediaContainer: { SearchResults: [{ SearchResult: [
      { Metadata: { guid: 'plex://show/BAD', title: 'The Mentalist', year: 2008 } },
      { Metadata: { guid: 'plex://show/RIGHT', title: 'The Mentalist', year: 2008 } },
      { Metadata: { guid: 'plex://show/THIRD', title: 'The Mentalist', year: 2008 } },
    ] }] } }]
    const { f, calls } = router([
      SEARCH_THREE,
      [/metadata\/BAD/, {}, 500],
      [/metadata\/RIGHT/, { MediaContainer: { Metadata: [{ Guid: [{ id: `tmdb://${id}` }] }] } }],
      ADD_OK,
    ])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.added).toBe(1)
    expect(calls.some(c => /addToWatchlist\?ratingKey=RIGHT/.test(c.url))).toBe(true)
    expect(store.listFailures()).toHaveLength(0)
  })

  it('records a retryable catalogue failure as a DEFERRAL on the short curve, not as a confirmed miss', async () => {
    // Deliberately NOT using follow(): no title_map row means titleExternalIds
    // must hit the catalogue over the network, and the router below has no
    // matching route for it, so the lookup 404s.
    store.putSyncRows('follows', [{ pk: 'T2', row: { titleId: 'T2', kind: 'show', deletedAt: null } }])
    const { f } = router([])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.deferred).toBe(1)
    expect(r.unresolved).toBe(0)
    expect(store.listFailures()).toHaveLength(1)

    // NOTE: this assertion used to be `toBeNull()` -- no plex_link row at all,
    // so the title stayed eligible on the very next run. That is the starvation
    // defect: a permanently-deferring title kept its batch slot forever. It now
    // gets a link row in its own state with a SHORT retry: minutes (because a
    // deferral is usually transient), never the hour-to-week `unresolved` curve.
    const l = store.getPlexLink('T2')!
    expect(l.state).toBe('deferred')
    expect(l.attempts).toBe(1)
    const wait = Date.parse(l.nextTryAt!) - Date.now()
    expect(wait).toBeGreaterThan(0)
    expect(wait).toBeLessThanOrEqual(reverseDeferBackoffMs(0))
    expect(wait).toBeLessThan(reverseBackoffMs(0)) // far shorter than a confirmed miss
  })

  // Starvation, proven: with REVERSE_BATCH=3 and three titles that defer on
  // every cycle, the good title behind them used to be unreachable forever --
  // dueUnlinkedTitles is ORDER BY sync_state.updated_at LIMIT n and a deferring
  // title's updated_at never moves. The realistic trigger is a bad PLEX_TOKEN,
  // where EVERY title defers and each one filed a failure + a notification per
  // cycle, every 30 minutes, with no backoff.
  it('lets a healthy title through past permanently-deferring ones, and notifies once per title, not once per cycle', async () => {
    for (const t of ['BAD1', 'BAD2', 'BAD3']) {
      store.putSyncRows('follows', [{ pk: t, row: { titleId: t, kind: 'show', deletedAt: null } }])
    }
    tick() // distinct updated_at: the deferrers sort ahead of the good title
    follow('GOOD', '5920')

    const { f, calls } = router([SEARCH_HIT, IDS_MATCH, ADD_OK]) // nothing routes the catalogue -> BAD* 404 -> defer
    const config = cfg({ REVERSE_BATCH: '3', NOTIFY_URL: NOTIFY })

    for (let i = 0; i < 5; i++) await reconcileWatchlist({ config, store, fetchImpl: f as any })

    expect(store.getPlexLink('GOOD')).toMatchObject({ ratingKey: 'RIGHT', state: 'added' })
    // One notification per deferring title, not one per title per cycle.
    expect(calls.filter(c => c.url === NOTIFY)).toHaveLength(3)
    // Failure rows are bounded by the deferral backoff too, not 3 x 5 cycles.
    expect(store.listFailures().length).toBeLessThanOrEqual(3)
  })

  // The starvation test above only proves "notifies once per title" via the
  // backoff -- its three bad titles each defer just once across five cycles,
  // so a per-cycle notification flood would never surface there. This test
  // forces a SECOND, genuinely-reprocessed deferral (nextTryAt pushed into the
  // past, not just a second call while still backed off) and checks the
  // notify guard directly: a bad PLEX_TOKEN that makes a title defer forever
  // must still notify only once, not every 30 minutes forever.
  it('notifies only once across two deferrals of the same title, even when the second is forced due', async () => {
    store.putSyncRows('follows', [{ pk: 'T2', row: { titleId: 'T2', kind: 'show', deletedAt: null } }])
    const { f, calls } = router([]) // no route for T2's catalogue lookup -> it 404s -> defer
    const config = cfg({ NOTIFY_URL: NOTIFY })

    const r1 = await reconcileWatchlist({ config, store, fetchImpl: f as any })
    expect(r1.deferred).toBe(1)
    const l1 = store.getPlexLink('T2')!
    expect(l1.state).toBe('deferred')
    expect(l1.attempts).toBe(1)

    // Force it due, as if the short deferral window had already elapsed, so
    // this second cycle genuinely re-processes T2 rather than skipping it via
    // the backoff (dueUnlinkedTitles would otherwise exclude it).
    store.putPlexLink({ titleId: 'T2', ratingKey: null, state: 'deferred', attempts: 1, nextTryAt: new Date(0).toISOString() })
    const r2 = await reconcileWatchlist({ config, store, fetchImpl: f as any })
    expect(r2.deferred).toBe(1)
    const l2 = store.getPlexLink('T2')!
    expect(l2.state).toBe('deferred')
    expect(l2.attempts).toBe(2)

    expect(calls.filter(c => c.url === NOTIFY)).toHaveLength(1)
  })

  it('clears a deferred title back to added once it succeeds', async () => {
    const id = follow('T1')
    const bad = router([])
    await reconcileWatchlist({ config: cfg(), store, fetchImpl: bad.f as any })
    expect(store.getPlexLink('T1')!.state).toBe('deferred')

    // Force it due, as if the short deferral window had elapsed, and let the
    // next cycle find its match.
    store.putPlexLink({ titleId: 'T1', ratingKey: null, state: 'deferred', attempts: 1, nextTryAt: new Date(0).toISOString() })
    const good = router([SEARCH_HIT, [/metadata\/RIGHT/, { MediaContainer: { Metadata: [{ Guid: [{ id: `tmdb://${id}` }] }] } }], ADD_OK])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: good.f as any })
    expect(r.added).toBe(1)
    expect(store.getPlexLink('T1')).toMatchObject({ state: 'added', ratingKey: 'RIGHT', attempts: 0, nextTryAt: null })
  })

  // I4: reverse adds it -> you remove it from the watchlist -> pulsarr's
  // watchlist.removed unfollows it on bingers -> the next pull sets deletedAt
  // -> you follow it again. The stale state='added' link used to survive that
  // round trip, leaving the title on neither the watchlist nor the queue.
  it('re-adds a title that was unfollowed on bingers and then followed again', async () => {
    const id = follow('T1')
    const IDS: [RegExp, unknown] = [/metadata\/RIGHT/, { MediaContainer: { Metadata: [{ Guid: [{ id: `tmdb://${id}` }] }] } }]
    const { f } = router([SEARCH_HIT, IDS, ADD_OK])
    expect((await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })).added).toBe(1)

    store.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: '2026-09-16T12:00:00.000Z' } }])
    // The link survives the unfollow so the sweep can take the title off plex,
    // but as 'remove': it no longer asserts the title is on the watchlist.
    expect(store.getPlexLink('T1')).toMatchObject({ state: 'remove', ratingKey: 'RIGHT' })
    expect(store.dueUnlinkedTitles(new Date().toISOString(), 10)).toEqual([]) // unfollowed: not a candidate

    store.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null } }])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.added).toBe(1)
    expect(store.getPlexLink('T1')).toMatchObject({ state: 'added', ratingKey: 'RIGHT' })
  })

  // A followed title the catalogue resolves fine but that carries no
  // tmdb/tvdb/imdb id at all: the branch was previously untested, and it is the
  // exact input to the dry-run defect below.
  function followWithoutIds(titleId: string) {
    store.putSyncRows('follows', [{ pk: titleId, row: { titleId, kind: 'show', deletedAt: null } }])
    return router([
      [/versions\.json/, { files: { metadata: 'abc' } }],
      [/metadata@abc\.json/, { id: titleId, title: 'The Mentalist', year: 2008, kind: 'show', external_ids: [] }],
    ])
  }

  it('records a title with no external ids as unresolved, naming that as the cause', async () => {
    const { f } = followWithoutIds('T1')
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.unresolved).toBe(1)
    expect(r.deferred).toBe(0) // the catalogue answered; this is a real miss, not an outage
    expect(store.getPlexLink('T1')).toMatchObject({ state: 'unresolved', attempts: 1 })
    expect(store.listFailures()[0]!.reason).toContain('no external ids')
  })

  // The no-external-ids branch used to run BEFORE the DRY_RUN check, so a dry
  // run wrote a real plex_link row with a backoff, filed a failure and POSTed
  // to NOTIFY_URL -- directly contradicting the comment next to it.
  it('writes nothing and notifies nobody under dry run for a title with no external ids', async () => {
    const { f, calls } = followWithoutIds('T1')
    const r = await reconcileWatchlist({ config: cfg({ DRY_RUN: 'true', NOTIFY_URL: NOTIFY }), store, fetchImpl: f as any })
    expect(r.skipped).toBe(1)
    expect(r.unresolved).toBe(0)
    expect(store.getPlexLink('T1')).toBeNull()
    expect(store.listFailures()).toHaveLength(0)
    expect(calls.filter(c => c.url === NOTIFY)).toHaveLength(0)
  })

  // The fix wave that added the DEFERRAL rate-limit also moved DRY_RUN above
  // the deferral branch, not just the failure branch: defer() became a writer
  // (plex_link + failures row) and a notifier. The likeliest real trigger is a
  // Bingers catalogue outage during a FIRST DRY_RUN=true run -- every title's
  // catalogue lookup fails, and without the check above the deferral branch a
  // dry run would write links, file failures and spam NOTIFY_URL.
  it('writes nothing and notifies nobody under dry run when a catalogue lookup fails (would-be deferral)', async () => {
    store.putSyncRows('follows', [{ pk: 'T2', row: { titleId: 'T2', kind: 'show', deletedAt: null } }])
    const { f, calls } = router([]) // no route for T2's catalogue lookup -> it 404s -> would-be defer
    const r = await reconcileWatchlist({ config: cfg({ DRY_RUN: 'true', NOTIFY_URL: NOTIFY }), store, fetchImpl: f as any })
    expect(r.skipped).toBe(1)
    expect(r.deferred).toBe(0)
    expect(store.getPlexLink('T2')).toBeNull()
    expect(store.listFailures()).toHaveLength(0)
    expect(calls.filter(c => c.url === NOTIFY)).toHaveLength(0)
  })

  it('names the actual cause: a missing title is not the same defect as missing ids', async () => {
    // Real ids, no title: the problem is that discover cannot be SEARCHED, not
    // that a match could not be verified.
    store.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null } }])
    store.putTitleMapping([{ source: 'tmdb', extId: '777', kind: 'show', titleId: 'T1', title: null, year: null }])
    const { f } = router([])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.unresolved).toBe(1)
    expect(store.listFailures()[0]!.reason).toContain('no searchable title')
    expect(store.listFailures()[0]!.reason).not.toContain('no external ids')
  })

  it('sends notifications through the injected fetch, never the real network', async () => {
    follow('T1')
    const { f, calls } = router([[/library\/search/, { MediaContainer: { SearchResults: [] } }]])
    await reconcileWatchlist({ config: cfg({ NOTIFY_URL: NOTIFY }), store, fetchImpl: f as any })
    const posted = calls.filter(c => c.url === NOTIFY)
    expect(posted).toHaveLength(1)
    expect(JSON.parse(posted[0]!.init.body).text).toContain('reverse sync:')
  })

  it('does not re-process an already linked title', async () => {
    follow('T1')  // IDS_MATCH is unused here; nothing should reach the network
    store.putPlexLink({ titleId: 'T1', ratingKey: 'RIGHT', state: 'added', attempts: 0, nextTryAt: null })
    const { f } = router([SEARCH_HIT, IDS_MATCH, ADD_OK])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.added).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })

  it('backs off on repeat failure rather than hammering discover, growing further each time', async () => {
    follow('T1')
    const { f } = router([[/library\/search/, { MediaContainer: { SearchResults: [] } }]])

    await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    const l1 = store.getPlexLink('T1')!
    expect(l1.state).toBe('unresolved')
    expect(l1.attempts).toBe(1)
    expect(Date.parse(l1.nextTryAt!)).toBeGreaterThan(Date.now())

    // Force the title due again, as if its first backoff had already elapsed,
    // and fail it a second time.
    store.putPlexLink({ titleId: 'T1', ratingKey: null, state: 'unresolved', attempts: l1.attempts, nextTryAt: new Date(0).toISOString() })
    await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    const l2 = store.getPlexLink('T1')!
    expect(l2.attempts).toBe(2)
    expect(Date.parse(l2.nextTryAt!)).toBeGreaterThan(Date.parse(l1.nextTryAt!))

    // Immediate re-run: nextTryAt from the second failure is still in the
    // future, so the title must not be picked up -- this is the actual
    // "doesn't retry every cycle" guarantee.
    f.mockClear()
    const r3 = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(f).not.toHaveBeenCalled()
    expect(r3).toEqual({ added: 0, removed: 0, preexisting: 0, unresolved: 0, skipped: 0, deferred: 0 })
  })

  it('respects a per-run budget so a first run cannot storm discover', async () => {
    for (const t of ['A', 'B', 'C', 'D']) follow(t)
    // Each title has a DIFFERENT extId, so none of them will intersect the fixed
    // tmdb://5920 in IDS_MATCH -- they land as unresolved. The point of this test
    // is the COUNT processed, not the outcome.
    const { f } = router([SEARCH_HIT, IDS_MATCH, ADD_OK])
    const r = await reconcileWatchlist({ config: cfg({ REVERSE_BATCH: '2' }), store, fetchImpl: f as any })
    expect(r.added + r.unresolved).toBe(2)
  })

  it('does nothing when reverse sync is disabled', async () => {
    follow('T1')
    const { f } = router([SEARCH_HIT, IDS_MATCH, ADD_OK])
    const r = await reconcileWatchlist({ config: cfg({ REVERSE_SYNC: 'false' }), store, fetchImpl: f as any })
    expect(r).toEqual({ added: 0, removed: 0, preexisting: 0, unresolved: 0, skipped: 0, deferred: 0 })
    expect(f).not.toHaveBeenCalled()
  })
})

describe('reconcileWatchlist removal sweep', () => {
  const REMOVE_OK: [RegExp, unknown] = [/removeFromWatchlist/, { MediaContainer: { size: 0 } }]
  // Removal is opt-in on its own: the cutoff alone only ever previews.
  const REMOVE = { REVERSE_REMOVE: 'true' }
  // A title we added that bingers no longer wants on the watchlist.
  const linkedButParked = (titleId: string, row: Record<string, unknown>) => {
    store.putSyncRows('follows', [{ pk: titleId, row: { titleId, kind: 'show', deletedAt: null, ...row } }])
    store.putPlexLink({ titleId, ratingKey: `rk-${titleId}`, state: 'added', attempts: 0, nextTryAt: null })
  }

  it('takes a parked title off the watchlist and forgets the link', async () => {
    linkedButParked('T1', { watchlistHiddenAt: '2026-09-20T10:00:00.000Z' })
    const { f, calls } = router([REMOVE_OK])
    const r = await reconcileWatchlist({ config: cfg(REMOVE), store, fetchImpl: f as any })
    expect(r.removed).toBe(1)
    expect(calls.some(c => /removeFromWatchlist\?ratingKey=rk-T1/.test(c.url))).toBe(true)
    expect(store.getPlexLink('T1')).toBeNull() // forgotten only after plex confirmed
  })

  it('takes off a title followed before the cutoff, and leaves a newer one alone', async () => {
    linkedButParked('OLD', { followedAt: '2012-11-26T16:28:00.000Z' })
    linkedButParked('NEW', { followedAt: '2026-09-21T09:00:00.000Z' })
    const { f, calls } = router([REMOVE_OK])
    const r = await reconcileWatchlist({ config: cfg({ ...REMOVE, REVERSE_FOLLOWED_SINCE: '2026-09-21' }), store, fetchImpl: f as any })
    expect(r.removed).toBe(1)
    expect(calls.filter(c => /removeFromWatchlist/.test(c.url)).map(c => c.url.match(/ratingKey=(\S+)/)![1])).toEqual(['rk-OLD'])
    expect(store.getPlexLink('NEW')).toMatchObject({ state: 'added' })
  })

  it('never adds a title it would also remove', async () => {
    // extId pinned to the one IDS_MATCH answers for: with the sequence follow()
    // hands out, the discover match would miss and this would pass whether or
    // not the cutoff filtered anything.
    follow('T1', '5920')
    store.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null, followedAt: '2012-11-26T16:28:00.000Z' } }])
    const { f, calls } = router([SEARCH_HIT, IDS_MATCH, ADD_OK, REMOVE_OK])
    const r = await reconcileWatchlist({ config: cfg({ REVERSE_FOLLOWED_SINCE: '2026-09-21' }), store, fetchImpl: f as any })
    expect(r.added).toBe(0)
    expect(calls.some(c => /addToWatchlist/.test(c.url))).toBe(false)
  })

  it('writes nothing to plex under DRY_RUN', async () => {
    linkedButParked('T1', { stoppedWatchingAt: '2026-09-20T10:00:00.000Z' })
    const { f, calls } = router([REMOVE_OK])
    const r = await reconcileWatchlist({ config: cfg({ ...REMOVE, DRY_RUN: 'true' }), store, fetchImpl: f as any })
    expect(r.removed).toBe(0)
    expect(calls.some(c => /removeFromWatchlist/.test(c.url))).toBe(false)
    expect(store.getPlexLink('T1')).toMatchObject({ state: 'added' }) // left exactly as eligible as it was found
  })

  // Keeping the link is the whole point: forget it and the title stays on the
  // watchlist with nothing left that knows how to take it off.
  it('keeps the link and backs off when plex refuses the removal', async () => {
    linkedButParked('T1', { forLaterAt: '2026-09-20T10:00:00.000Z' })
    const { f } = router([[/removeFromWatchlist/, {}, 503]])
    const r = await reconcileWatchlist({ config: cfg(REMOVE), store, fetchImpl: f as any })
    expect(r.removed).toBe(0)
    const link = store.getPlexLink('T1')
    expect(link).toMatchObject({ ratingKey: 'rk-T1' })
    expect(link!.attempts).toBe(1)
    expect(Date.parse(link!.nextTryAt!)).toBeGreaterThan(Date.now())
    expect(store.listFailures().some(x => /removeFromWatchlist/.test(x.reason))).toBe(true)
  })

  it('honours REVERSE_BATCH so a backlog drains in bounded steps', async () => {
    for (const t of ['A', 'B', 'C']) linkedButParked(t, { watchlistHiddenAt: '2026-09-20T10:00:00.000Z' })
    const { f, calls } = router([REMOVE_OK])
    const r = await reconcileWatchlist({ config: cfg({ ...REMOVE, REVERSE_BATCH: '2' }), store, fetchImpl: f as any })
    expect(r.removed).toBe(2)
    expect(calls.filter(c => /removeFromWatchlist/.test(c.url))).toHaveLength(2)
  })
})

describe('removal preview', () => {
  const linked = (titleId: string, title: string, row: Record<string, unknown>) => {
    store.putSyncRows('follows', [{ pk: titleId, row: { titleId, kind: 'show', deletedAt: null, ...row } }])
    store.putTitleMapping([{ source: 'tmdb', extId: `x${titleId}`, kind: 'show', titleId, title, year: 2008 }])
    store.putPlexLink({ titleId, ratingKey: `rk-${titleId}`, state: 'added', attempts: 0, nextTryAt: null })
  }

  it('lists what it would remove, and touches nothing, until REVERSE_REMOVE says otherwise', async () => {
    linked('T1', 'Zack and Miri Make a Porno', { followedAt: '2012-11-26T16:28:00.000Z' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { f, calls } = router([[/removeFromWatchlist/, { MediaContainer: { size: 0 } }]])
    try {
      const r = await reconcileWatchlist({ config: cfg({ REVERSE_FOLLOWED_SINCE: '2026-09-21' }), store, fetchImpl: f as any })
      expect(r.removed).toBe(0)
      expect(calls.some(c => /removeFromWatchlist/.test(c.url))).toBe(false)
      expect(store.getPlexLink('T1')).toMatchObject({ state: 'added' })
      const line = log.mock.calls.map(c => c.join(' ')).find(l => /would remove/.test(l))
      expect(line).toMatch(/Zack and Miri Make a Porno/)
      expect(line).toMatch(/followed before 2026-09-21/) // why, not just what
    } finally { log.mockRestore() }
  })

  // The sweep is batched so a live run drains in bounded steps, but a preview
  // that showed 10 of 246 would be useless for deciding whether to run it.
  it('previews the whole backlog, not one REVERSE_BATCH of it', async () => {
    for (const t of ['A', 'B', 'C']) linked(t, `Title ${t}`, { watchlistHiddenAt: '2026-09-20T10:00:00.000Z' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { f } = router([])
    try {
      await reconcileWatchlist({ config: cfg({ REVERSE_BATCH: '2' }), store, fetchImpl: f as any })
      expect(log.mock.calls.map(c => c.join(' ')).filter(l => /would remove/.test(l))).toHaveLength(3)
    } finally { log.mockRestore() }
  })

  it('needs REVERSE_REMOVE to be exactly "true" before it touches plex', async () => {
    linked('T1', 'Tires', { watchlistHiddenAt: '2026-09-20T10:00:00.000Z' })
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { f, calls } = router([[/removeFromWatchlist/, { MediaContainer: { size: 0 } }]])
    try {
      const r = await reconcileWatchlist({ config: cfg({ REVERSE_REMOVE: 'yes' }), store, fetchImpl: f as any })
      expect(r.removed).toBe(0)
      expect(calls.some(c => /removeFromWatchlist/.test(c.url))).toBe(false)
    } finally { log.mockRestore() }
  })
})

describe('watchlist provenance', () => {
  // The defect this exists to prevent: addToWatchlist answers 200 whether or
  // not the title was already there, so a successful call proved nothing about
  // who put it on the list. 187 of 254 links turned out to be titles the user
  // had watchlisted themselves, and the sweep would have taken them off.
  const ON_WATCHLIST: [RegExp, unknown] = [/sections\/watchlist\/all/,
    { MediaContainer: { totalSize: 1, Metadata: [{ ratingKey: 'RIGHT' }] } }]

  it('records a title already on your watchlist as preexisting, and does not add it', async () => {
    follow('T1', '5920')
    const { f, calls } = router([ON_WATCHLIST, SEARCH_HIT, IDS_MATCH, ADD_OK])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.added).toBe(0)
    expect(r.preexisting).toBe(1)
    expect(calls.some(c => /addToWatchlist/.test(c.url))).toBe(false)
    expect(store.getPlexLink('T1')).toMatchObject({ state: 'preexisting', ratingKey: 'RIGHT' })
  })

  it('never offers a preexisting title for removal, however old the follow', async () => {
    store.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null, followedAt: '2012-11-26T16:28:00.000Z' } }])
    store.putPlexLink({ titleId: 'T1', ratingKey: 'RIGHT', state: 'preexisting', attempts: 0, nextTryAt: null })
    const { f, calls } = router([[/removeFromWatchlist/, { MediaContainer: { size: 0 } }]])
    const r = await reconcileWatchlist({
      config: cfg({ REVERSE_REMOVE: 'true', REVERSE_FOLLOWED_SINCE: '2026-09-21' }), store, fetchImpl: f as any })
    expect(r.removed).toBe(0)
    expect(calls.some(c => /removeFromWatchlist/.test(c.url))).toBe(false)
    expect(store.getPlexLink('T1')).toMatchObject({ state: 'preexisting' })
  })

  // Adding blind is what caused the damage, so an unreadable watchlist must
  // stop the add loop rather than fall back to the old behaviour.
  it('defers instead of adding blind when the watchlist cannot be read', async () => {
    follow('T1', '5920')
    const { f, calls } = router([[/sections\/watchlist\/all/, {}, 500], SEARCH_HIT, IDS_MATCH, ADD_OK])
    const r = await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(r.added).toBe(0)
    expect(r.deferred).toBe(1)
    expect(calls.some(c => /addToWatchlist/.test(c.url))).toBe(false)
  })

  it('reads the watchlist once per run, not once per title', async () => {
    for (const t of ['T1', 'T2', 'T3']) follow(t)
    const { f, calls } = router([SEARCH_HIT, IDS_MATCH, ADD_OK])
    await reconcileWatchlist({ config: cfg(), store, fetchImpl: f as any })
    expect(calls.filter(c => /sections\/watchlist\/all/.test(c.url))).toHaveLength(1)
  })
})
