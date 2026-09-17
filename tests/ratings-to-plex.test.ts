import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { createGate } from '../src/outbox.js'
import { loadConfig } from '../src/config.js'
import { syncRatingsToPlex } from '../src/ratings/toPlex.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const cfg = (over: Record<string, string> = {}) => loadConfig({
  BINGERS_SESSION_COOKIE: 'c', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt',
  ALLOWED_USER: 'testuser', DRY_RUN: 'false', ...over,
} as NodeJS.ProcessEnv)
const deps = (f: any, c = cfg()) => ({
  config: c, store, auth: createAuth(store, 'TOK', 'UA'), gate: createGate(), fetchImpl: f as typeof fetch,
})

function router(routes: [RegExp, unknown][]) {
  const calls: { url: string; init?: any }[] = []
  const f = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    for (const [re, body] of routes) if (re.test(url)) return new Response(JSON.stringify(body), { status: 200 })
    return new Response('{}', { status: 404 })
  })
  return { f, calls }
}

// a bingers-rated movie sitting in sync_state, with its ids cached
function bingersRatedMovie(rating: number) {
  store.putSyncRows('entries', [{ pk: `movie:M1`, row: { entityKind: 'movie', entityId: 'M1', rating, watched: true, deletedAt: null } }])
  store.putTitleMapping([{ source: 'tmdb', extId: '467244', kind: 'movie', titleId: 'M1', title: 'The Zone of Interest', year: 2023 }])
}
const MOVIE_SECTION: [RegExp, unknown] = [/library\/sections$/, { MediaContainer: { Directory: [
  { key: '2', type: 'movie', title: 'Filme' },
] } }]
// NOTE: this stands in for fetchSectionGuidIndex, which lists the WHOLE section
// with no rating filter — an unrated movie is exactly what we need to find here.
const SECTION_SCAN: [RegExp, unknown] = [/sections\/2\/all/, { MediaContainer: { Metadata: [
  { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', Guid: [{ id: 'tmdb://467244' }] },
] } }]
const RATE_OK: [RegExp, unknown] = [/:\/rate/, {}]

describe('syncRatingsToPlex', () => {
  it('writes a bingers-authored rating to plex, converting the scale', async () => {
    bingersRatedMovie(4)
    const { f, calls } = router([MOVIE_SECTION, SECTION_SCAN, RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(1)
    const rate = calls.find(c => /:\/rate/.test(c.url))!
    expect(rate.url).toContain('key=46807')
    expect(rate.url).toContain('rating=8')
    expect(rate.init.method).toBe('PUT')
  })

  it('REFUSES to write back a rating that plex authored — the whole point of origin tracking', async () => {
    bingersRatedMovie(5)
    // plex rated it 9 (4.5 stars); bingers holds the rounded 5. Writing back would make it 10.
    store.putRatingLink({ entityKind: 'movie', entityId: 'M1', bingersRating: 5, plexRating: 9,
      plexRatingKey: '46807', origin: 'plex' })
    const { f, calls } = router([MOVIE_SECTION, SECTION_SCAN, RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(0)
    // Layer 1 specifically: SECTION_SCAN carries no live userRating, so
    // layer 2 could not have caught this one.
    expect(r.refusedOrigin).toBe(1)
    expect(r.refusedHalfStar).toBe(0)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  it('does not rewrite a rating plex already agrees with (checked against plex\'s CURRENT live value)', async () => {
    bingersRatedMovie(4)
    store.putRatingLink({ entityKind: 'movie', entityId: 'M1', bingersRating: 4, plexRating: 8,
      plexRatingKey: '46807', origin: 'bingers' })
    // Plex's live scan reports userRating 8 -- it already agrees with bingers' 4.
    const { f, calls } = router([MOVIE_SECTION, [/sections\/2\/all/, { MediaContainer: { Metadata: [
      { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 8, Guid: [{ id: 'tmdb://467244' }] },
    ] } }], RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(0)
    expect(r.skipped).toBe(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  it('F1 regression: a MISSING rating_link is not permission to write -- the live plex value decides', async () => {
    bingersRatedMovie(5)
    // No rating_link exists at all for this pair (pre-existing data, or an
    // unresolved/failed fromPlex.ts pass). Plex's live scan shows it is
    // currently rated 9 (4.5 stars), which already rounds down to bingers'
    // 5. bingersToPlex(5) is 10 -- writing that back would inflate the
    // user's half-star to a full 5-star rating, silently and unrecoverably.
    expect(store.getRatingLink('movie', 'M1')).toBeNull()
    const { f, calls } = router([MOVIE_SECTION, [/sections\/2\/all/, { MediaContainer: { Metadata: [
      { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 9, Guid: [{ id: 'tmdb://467244' }] },
    ] } }], RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(0)
    // 9 is odd (a half-star): the guard is actively declining a write, not
    // silently deduplicating -- R3 says that must be `refused`, not `skipped`.
    // LAYER 2, with no rating_link at all, so layer 1 cannot be what fired.
    expect(r.refusedHalfStar).toBe(1)
    expect(r.refusedOrigin).toBe(0)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  it('R3: a genuine bingers rating change that still rounds to the same odd plex value is REFUSED, not silently skipped', async () => {
    bingersRatedMovie(5) // bingers now says 5
    // The link's bookkeeping is stale: it still says 4, from before the user
    // changed their bingers rating to 5. Plex's live scan is 9 (odd,
    // half-star) which rounds down to 5 either way, so layer 2's predicate
    // fires -- but a real bingers change happened, and declining to write
    // must be visible, not silent.
    store.putRatingLink({ entityKind: 'movie', entityId: 'M1', bingersRating: 4, plexRating: 8,
      plexRatingKey: '46807', origin: 'bingers' })
    const { f } = router([MOVIE_SECTION, [/sections\/2\/all/, { MediaContainer: { Metadata: [
      { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 9, Guid: [{ id: 'tmdb://467244' }] },
    ] } }], RATE_OK])
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r = await syncRatingsToPlex(deps(f))
      expect(r.written).toBe(0)
      expect(r.skipped).toBe(0)
      expect(r.refusedHalfStar).toBe(1)
      expect(r.refusedOrigin).toBe(0)
      expect(spy.mock.calls.some(c => String(c[0]).includes('M1'))).toBe(true)
    } finally {
      spy.mockRestore()
    }
  })

  it('R3: a true no-op (even plex value already matching) stays silent and skipped, not refused', async () => {
    bingersRatedMovie(4)
    store.putRatingLink({ entityKind: 'movie', entityId: 'M1', bingersRating: 4, plexRating: 8,
      plexRatingKey: '46807', origin: 'bingers' })
    const { f } = router([MOVIE_SECTION, [/sections\/2\/all/, { MediaContainer: { Metadata: [
      { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 8, Guid: [{ id: 'tmdb://467244' }] },
    ] } }], RATE_OK])
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r = await syncRatingsToPlex(deps(f))
      expect(r.written).toBe(0)
      expect(r.skipped).toBe(1)
      expect(r.refusedHalfStar).toBe(0)
      expect(r.refusedOrigin).toBe(0)
      expect(spy.mock.calls.some(c => String(c[0]).includes('[refused]'))).toBe(false)
    } finally {
      spy.mockRestore()
    }
  })

  // Layer 1 fires on a permanent STEADY STATE (plex authored it, bingers has
  // not changed it), not on an event, so it gets ONE summary line per run --
  // 25 identical per-item lines drowned the Layer 2 lines that are real
  // events. Two rows here, so "one line" cannot be satisfied by one row.
  it('summarises layer-1 refusals in a single live line rather than one per item', async () => {
    bingersRatedMovie(5)
    store.putSyncRows('entries', [{ pk: 'movie:M2', row: { entityKind: 'movie', entityId: 'M2', rating: 4, watched: true, deletedAt: null } }])
    store.putTitleMapping([{ source: 'tmdb', extId: '999999', kind: 'movie', titleId: 'M2', title: null, year: null }])
    store.putRatingLink({ entityKind: 'movie', entityId: 'M1', bingersRating: 5, plexRating: 9,
      plexRatingKey: '46807', origin: 'plex' })
    store.putRatingLink({ entityKind: 'movie', entityId: 'M2', bingersRating: 4, plexRating: 8,
      plexRatingKey: '11111', origin: 'plex' })
    const { f, calls } = router([MOVIE_SECTION, SECTION_SCAN, RATE_OK])
    const spy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      const r = await syncRatingsToPlex(deps(f)) // DRY_RUN: 'false', a live run
      expect(r.refusedOrigin).toBe(2)
      expect(r.refusedHalfStar).toBe(0)
      expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
      const lines = spy.mock.calls.filter(c => String(c[0]).includes('[refused]'))
      expect(lines).toHaveLength(1)
      expect(String(lines[0]![0])).toContain('2 rating(s)')
    } finally {
      spy.mockRestore()
    }
  })

  // The narrowing. Layer 1 used to refuse anything plex had EVER authored,
  // and that link never re-originates -- so after the first fromPlex run a
  // rating the user later changed in bingers could never reach plex again,
  // for most of the library. README promised the opposite.
  it('writes a plex-authored rating the user has SINCE CHANGED in bingers', async () => {
    bingersRatedMovie(3) // the user changed it to 3; the link still records the mirrored 5
    store.putRatingLink({ entityKind: 'movie', entityId: 'M1', bingersRating: 5, plexRating: 9,
      plexRatingKey: '46807', origin: 'plex' })
    const { f, calls } = router([MOVIE_SECTION, [/sections\/2\/all/, { MediaContainer: { Metadata: [
      { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 9, Guid: [{ id: 'tmdb://467244' }] },
    ] } }], RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(1)
    expect(r.refusedOrigin).toBe(0)
    expect(r.refusedHalfStar).toBe(0)
    // Layer 2 still ran and still agreed: plexToBingers(9) is 5, not 3.
    expect(calls.find(c => /:\/rate/.test(c.url))!.url).toContain('rating=6')
  })

  // What Layer 1 is actually FOR, and the one case layer 2 cannot cover: the
  // user CLEARED the rating in plex, so entry.userRating is null, layer 2's
  // guard is `!= null && ...` and falls through -- and the bingers value plex
  // itself produced would resurrect a rating the user deliberately removed.
  it('does not resurrect a rating the user CLEARED in plex', async () => {
    bingersRatedMovie(5)
    store.putRatingLink({ entityKind: 'movie', entityId: 'M1', bingersRating: 5, plexRating: 9,
      plexRatingKey: '46807', origin: 'plex' })
    // SECTION_SCAN carries NO userRating key at all -- plex holds no rating now.
    const { f, calls } = router([MOVIE_SECTION, SECTION_SCAN, RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(0)
    expect(r.refusedOrigin).toBe(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  // The window the narrowing would otherwise open. src/outbox.ts mirrors a
  // rating into sync_state only once bingers CONFIRMS it, so while a
  // plex->bingers push is queued (bingers unreachable, or the gate halted)
  // the stored rating is the PRE-push value. Read as "the user changed it in
  // bingers", it licenses a write back over the plex half-star it came from:
  // bingers 5 (stale), plex 7 -> plexToBingers(7) is 4 != 5 -> write 10.
  it('does not mistake a queued, unconfirmed plex->bingers push for a bingers-side change', async () => {
    bingersRatedMovie(5) // stale: the push that would make this 4 never landed
    store.putRatingLink({ entityKind: 'movie', entityId: 'M1', bingersRating: 4, plexRating: 7,
      plexRatingKey: '46807', origin: 'plex' })
    store.enqueueOps([{ opId: 'op-9', table: 'entries', pk: { entityKind: 'movie', entityId: 'M1' }, fields: { rating: 4 } }])
    const { f, calls } = router([MOVIE_SECTION, [/sections\/2\/all/, { MediaContainer: { Metadata: [
      { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 7, Guid: [{ id: 'tmdb://467244' }] },
    ] } }], RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(0)
    expect(r.refusedOrigin).toBe(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  it('a plex section-scan failure is caught: counters stay intact, a failure is recorded, no unhandled rejection', async () => {
    bingersRatedMovie(4)
    // MOVIE_SECTION resolves, but the section-scan endpoint is NOT routed --
    // it 404s, so fetchSectionGuidIndex (called from movieIndex) throws.
    const { f, calls } = router([MOVIE_SECTION, RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.failed).toBe(1)
    expect(r.unmapped).toBe(1)
    expect(r.written).toBe(0)
    const failures = store.listFailures()
    expect(failures.some(x => /section scan failed/.test(x.reason))).toBe(true)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  it('R5: one section-scan outage is ONE failure, not one per blocked row', async () => {
    store.putSyncRows('entries', [
      { pk: 'movie:M1', row: { entityKind: 'movie', entityId: 'M1', rating: 4, watched: true, deletedAt: null } },
      { pk: 'movie:M2', row: { entityKind: 'movie', entityId: 'M2', rating: 3, watched: true, deletedAt: null } },
      { pk: 'movie:M3', row: { entityKind: 'movie', entityId: 'M3', rating: 5, watched: true, deletedAt: null } },
    ])
    store.putTitleMapping([
      { source: 'tmdb', extId: '1', kind: 'movie', titleId: 'M1', title: null, year: null },
      { source: 'tmdb', extId: '2', kind: 'movie', titleId: 'M2', title: null, year: null },
      { source: 'tmdb', extId: '3', kind: 'movie', titleId: 'M3', title: null, year: null },
    ])
    // The scan fails once; all three rows need it.
    const { f, calls } = router([MOVIE_SECTION, RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.failed).toBe(1)
    expect(r.unmapped).toBe(3)
    expect(r.written).toBe(0)
    expect(store.listFailures().filter(x => /section scan failed/.test(x.reason))).toHaveLength(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  // Task 6 added per-episode ratingKey resolution (show -> allLeaves), but it
  // needs an episode_map position AND a cached show ratingKey. E1 has neither.
  it('an episode with no episode_map position is counted unmapped', async () => {
    store.putSyncRows('entries', [{ pk: 'episode:E1', row: { entityKind: 'episode', entityId: 'E1', rating: 4, watched: true, deletedAt: null } }])
    const { f, calls } = router([MOVIE_SECTION, SECTION_SCAN, RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.unmapped).toBe(1)
    expect(r.written).toBe(0)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  it('counts a title it cannot map to a plex item, without writing', async () => {
    bingersRatedMovie(4)
    const { f, calls } = router([MOVIE_SECTION, [/sections\/2\/all/, { MediaContainer: { Metadata: [] } }], RATE_OK])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.unmapped).toBe(1)
    expect(r.written).toBe(0)
    expect(r.failed).toBe(0) // an empty section is not an outage
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  it('writes nothing under dry run', async () => {
    bingersRatedMovie(4)
    const { f, calls } = router([MOVIE_SECTION, SECTION_SCAN, RATE_OK])
    const r = await syncRatingsToPlex(deps(f, cfg({ DRY_RUN: 'true' })))
    expect(r.written).toBe(0)
    // `skipped` is the would-be write: without it this passes just as well
    // when the row never resolved to a plex item at all.
    expect(r.skipped).toBe(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
    expect(store.getRatingLink('movie', 'M1')).toBeNull()
  })

  it('records bingers as the origin after a successful write', async () => {
    bingersRatedMovie(4)
    const { f } = router([MOVIE_SECTION, SECTION_SCAN, RATE_OK])
    await syncRatingsToPlex(deps(f))
    const l = store.getRatingLink('movie', 'M1')!
    expect(l.origin).toBe('bingers')
    expect(l.plexRating).toBe(8)
    expect(l.plexRatingKey).toBe('46807')
  })
})

// A bingers-rated episode sitting in sync_state, with episode_map position
// and its SHOW's external ids cached (the ids used for F1's read-site
// verification, not the episode's own -- episode_map has no ids of its own).
function bingersRatedEpisode(entityId: string, rating: number, titleId: string, season: number, number: number, tmdbId: string) {
  store.putSyncRows('entries', [{ pk: `episode:${entityId}`, row: { entityKind: 'episode', entityId, rating, deletedAt: null } }])
  store.putEpisodes([{ titleId, season, number, episodeId: entityId, abs: null, title: null, aired: null, seasonHash: 'h' }])
  store.putTitleMapping([{ source: 'tmdb', extId: tmdbId, kind: 'show', titleId, title: null, year: null }])
}
// fetchShowIds route for a given local ratingKey, returning ids that verify
// against `bingersRatedEpisode`'s tmdbId (or a DIFFERENT id, to simulate a
// stale/poisoned cache pointing at a foreign show).
const showIdsRoute = (ratingKey: string, tmdbId: string): [RegExp, unknown] =>
  [new RegExp(`metadata/${ratingKey}\\?includeGuids`), { MediaContainer: { Metadata: [{ Guid: [{ id: `tmdb://${tmdbId}` }] }] } }]

describe('episode ratings to plex', () => {
  it('walks show -> allLeaves to find the local episode ratingKey', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522')
    store.putShowRatingKey('T1', '90363')
    const { f, calls } = router([
      showIdsRoute('90363', '247522'),
      [/metadata\/90363\/allLeaves/, { MediaContainer: { Metadata: [
        { ratingKey: '90364', parentIndex: 1, index: 1 },
        { ratingKey: '90366', parentIndex: 1, index: 3 },
      ] } }],
      [/:\/rate/, {}],
    ])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(1)
    expect(calls.find(c => /:\/rate/.test(c.url))!.url).toContain('key=90366')
  })

  it('counts an episode as unmapped when no show ratingKey is known', async () => {
    bingersRatedEpisode('E9', 4, 'T9', 1, 1, '999999')
    const { f, calls } = router([[/:\/rate/, {}]])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.unmapped).toBe(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
    // Legitimately nothing known yet -- not a verification failure or an
    // outage, so nothing is recorded to the failures table.
    expect(store.listFailures()).toHaveLength(0)
  })

  // THE HALF-STAR REGRESSION TEST. Bingers holds 5; plex already holds 9 (4.5
  // stars). bingersToPlex(5) is 10, so an unguarded write would destroy the
  // half-star. Layer 2 must see the leaf's live userRating and refuse.
  it('refuses to inflate an episode half-star plex already holds', async () => {
    bingersRatedEpisode('E5', 5, 'T5', 2, 1, '555555')
    store.putShowRatingKey('T5', '90400')
    const { f, calls } = router([
      showIdsRoute('90400', '555555'),
      [/metadata\/90400\/allLeaves/, { MediaContainer: { Metadata: [
        { ratingKey: '90401', parentIndex: 2, index: 1, userRating: 9 },
      ] } }],
      [/:\/rate/, {}],
    ])
    const r = await syncRatingsToPlex(deps(f))
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
    expect(r.written).toBe(0)
    // Without this the test passes identically against a completely broken
    // episode mapping: `unmapped: 1` also produces no write. Only the LAYER 2
    // counter proves the leaf WAS found and that layer 2 is what declined.
    expect(r.refusedHalfStar).toBe(1)
    expect(r.refusedOrigin).toBe(0)
  })

  // THE F1 REGRESSION TEST. `putShowRatingKey` is populated from a scrobble's
  // grandparentRatingKey with no verification at write time (by design --
  // see src/handlers.ts), and /plex carries no shared secret. A stale or
  // poisoned cache entry must never be trusted on read: here T1's cached
  // ratingKey (90363) actually belongs to a FOREIGN show (tmdb 000000, not
  // T1's own 247522), so the read-site intersection must fail and refuse to
  // touch it -- exactly the hazard Task 5 closed for movies, reopened for
  // episodes by an unverified cache, and closed again here.
  it('declines to write when the cached show ratingKey points at a foreign show, and clears the entry (L1/L2)', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522')
    store.putShowRatingKey('T1', '90363') // stale/poisoned: actually a different show
    const { f, calls } = router([
      showIdsRoute('90363', '000000'), // foreign show's ids -- SAME source (tmdb), disagreeing value
      [/metadata\/90363\/allLeaves/, { MediaContainer: { Metadata: [
        { ratingKey: '55501', parentIndex: 1, index: 3 },
      ] } }],
      [/:\/rate/, {}],
    ])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(0)
    expect(r.unmapped).toBe(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
    // L2: a provable disagreement gets its own message, distinct from L2's
    // "cannot tell" case below.
    expect(store.listFailures().some(x => /denotes a different show/.test(x.reason))).toBe(true)
    // L1: proven wrong, so the entry is discarded rather than left to rot.
    expect(store.showRatingKeyFor('T1')).toBeNull()
  })

  // L1: without the delete, a provably-stale entry burns a fetchShowIds and
  // emits an identical failure row every run, forever. With it, the SECOND
  // run for the same show makes no fetchShowIds call at all -- there is
  // nothing left to verify.
  it('performs no fetchShowIds on a later run once a mismatched show ratingKey has been cleared (L1)', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522')
    store.putShowRatingKey('T1', '90363')
    const first = router([
      showIdsRoute('90363', '000000'),
      [/metadata\/90363\/allLeaves/, { MediaContainer: { Metadata: [{ ratingKey: '55501', parentIndex: 1, index: 3 }] } }],
      [/:\/rate/, {}],
    ])
    await syncRatingsToPlex(deps(first.f))
    expect(store.showRatingKeyFor('T1')).toBeNull()

    const second = router([
      showIdsRoute('90363', '000000'),
      [/metadata\/90363\/allLeaves/, { MediaContainer: { Metadata: [{ ratingKey: '55501', parentIndex: 1, index: 3 }] } }],
      [/:\/rate/, {}],
    ])
    const r2 = await syncRatingsToPlex(deps(second.f))
    expect(second.calls.some(c => /includeGuids/.test(c.url))).toBe(false)
    expect(r2.unmapped).toBe(1)
  })

  // L2: no overlapping id source at all is a DIFFERENT event from a proven
  // mismatch -- the cache might still be correct, so it must survive.
  it('leaves the cached show ratingKey in place when there is no shared id source to compare (L2)', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522') // T1 only has a tmdb id
    store.putShowRatingKey('T1', '90363')
    const { f, calls } = router([
      // plex reports only a tvdb id for this ratingKey -- no source overlaps
      // with T1's cached tmdb id, so nothing here PROVES the cache wrong.
      [/metadata\/90363\?includeGuids/, { MediaContainer: { Metadata: [{ Guid: [{ id: 'tvdb://999999' }] }] } }],
      [/:\/rate/, {}],
    ])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.unmapped).toBe(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
    expect(store.listFailures().some(x => /could not be verified/.test(x.reason))).toBe(true)
    expect(store.listFailures().some(x => /denotes a different show/.test(x.reason))).toBe(false)
    // Left alone, not deleted.
    expect(store.showRatingKeyFor('T1')).toBe('90363')
  })

  it('counts an episode as unmapped when its show has no leaf at that season/number', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522')
    store.putShowRatingKey('T1', '90363')
    const { f, calls } = router([
      showIdsRoute('90363', '247522'),
      [/metadata\/90363\/allLeaves/, { MediaContainer: { Metadata: [
        { ratingKey: '90364', parentIndex: 1, index: 1 }, // no S1E3 here
      ] } }],
      [/:\/rate/, {}],
    ])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.unmapped).toBe(1)
    expect(r.written).toBe(0)
    expect(r.failed).toBe(0) // the show resolved fine; only the leaf is absent
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
  })

  it('writes nothing for an episode under DRY_RUN', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522')
    store.putShowRatingKey('T1', '90363')
    const { f, calls } = router([
      showIdsRoute('90363', '247522'),
      [/metadata\/90363\/allLeaves/, { MediaContainer: { Metadata: [
        { ratingKey: '90366', parentIndex: 1, index: 3, userRating: 6 },
      ] } }],
      [/:\/rate/, {}],
    ])
    const r = await syncRatingsToPlex(deps(f, cfg({ DRY_RUN: 'true' })))
    expect(r.written).toBe(0)
    // Same reason as the movie dry-run test: `unmapped: 1` would satisfy
    // "no write happened" while proving the episode walk is broken.
    expect(r.skipped).toBe(1)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
    expect(store.getRatingLink('episode', 'E3')).toBeNull()
  })

  it('records bingers as the origin after a successful episode write', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522')
    store.putShowRatingKey('T1', '90363')
    const { f } = router([
      showIdsRoute('90363', '247522'),
      [/metadata\/90363\/allLeaves/, { MediaContainer: { Metadata: [
        { ratingKey: '90366', parentIndex: 1, index: 3 },
      ] } }],
      [/:\/rate/, {}],
    ])
    await syncRatingsToPlex(deps(f))
    const l = store.getRatingLink('episode', 'E3')!
    expect(l.origin).toBe('bingers')
    expect(l.plexRatingKey).toBe('90366')
  })

  // F3: one allLeaves outage is one incident, not one per row it blocks --
  // the same rule R5 already established for the movie section scan.
  it('counts an allLeaves outage once, blocks every row of that show as unmapped, and records one failure row', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522')
    bingersRatedEpisode('E4', 3, 'T1', 1, 4, '247522')
    store.putShowRatingKey('T1', '90363')
    const { f, calls } = router([
      showIdsRoute('90363', '247522'),
      // allLeaves deliberately NOT stubbed -- the router 404s, which
      // fetchAllLeaves surfaces as a thrown error (an outage).
      [/:\/rate/, {}],
    ])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.failed).toBe(1)
    expect(r.unmapped).toBe(2)
    expect(calls.some(c => /:\/rate/.test(c.url))).toBe(false)
    expect(store.listFailures().filter(x => /allLeaves failed/.test(x.reason))).toHaveLength(1)
  })

  // F2: the show is fetched/verified at most once per run, no matter how
  // many of its episodes are rated -- not once per episode.
  it('resolves a show at most once per run for two of its episodes', async () => {
    bingersRatedEpisode('E3', 4, 'T1', 1, 3, '247522')
    bingersRatedEpisode('E4', 3, 'T1', 1, 4, '247522')
    store.putShowRatingKey('T1', '90363')
    const { f, calls } = router([
      showIdsRoute('90363', '247522'),
      [/metadata\/90363\/allLeaves/, { MediaContainer: { Metadata: [
        { ratingKey: '90366', parentIndex: 1, index: 3 },
        { ratingKey: '90367', parentIndex: 1, index: 4 },
      ] } }],
      [/:\/rate/, {}],
    ])
    const r = await syncRatingsToPlex(deps(f))
    expect(r.written).toBe(2)
    expect(calls.filter(c => /includeGuids/.test(c.url))).toHaveLength(1)
    expect(calls.filter(c => /allLeaves/.test(c.url))).toHaveLength(1)
  })
})

describe('show ratingKey capture', () => {
  it('stores and returns a show ratingKey', () => {
    expect(store.showRatingKeyFor('T1')).toBeNull()
    store.putShowRatingKey('T1', '90363')
    expect(store.showRatingKeyFor('T1')).toBe('90363')
  })
})
