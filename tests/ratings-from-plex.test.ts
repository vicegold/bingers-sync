import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { createGate } from '../src/outbox.js'
import { loadConfig } from '../src/config.js'
import { syncRatingsFromPlex } from '../src/ratings/fromPlex.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const cfg = (over: Record<string, string> = {}) => loadConfig({
  BINGERS_SESSION_COOKIE: 'c', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt',
  ALLOWED_USER: 'testuser', DRY_RUN: 'false', ...over,
} as NodeJS.ProcessEnv)

const deps = (f: any) => ({
  config: cfg(), store, auth: createAuth(store, 'TOK', 'UA'), gate: createGate(),
  fetchImpl: f as typeof fetch, newId: () => 'op-1',
})

function router(routes: [RegExp, unknown, number?][]) {
  const calls: { url: string; init?: any }[] = []
  const f = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    for (const [re, body, status] of routes) if (re.test(url)) return new Response(JSON.stringify(body), { status: status ?? 200 })
    return new Response('{}', { status: 404 })
  })
  return { f, calls }
}

const SECTIONS: [RegExp, unknown] = [/library\/sections$/, { MediaContainer: { Directory: [
  { key: '1', type: 'show', title: 'Serien' },
  { key: '2', type: 'movie', title: 'Filme' },
  { key: '8', type: 'artist', title: 'Hörbücher' },
] } }]
const NO_ITEMS: [RegExp, unknown] = [/sections\/\d+\/all/, { MediaContainer: { Metadata: [] } }]
const PUSH_OK: [RegExp, unknown] = [/sync\/push/, { results: [{ opId: 'op-1', status: 'applied' }], rows: {} }]

function ratedMovie(userRating: number, ratingKey = '46807') {
  return [/sections\/2\/all/, { MediaContainer: { Metadata: [
    { ratingKey, type: 'movie', title: 'The Zone of Interest', userRating, lastRatedAt: 1764000001,
      Guid: [{ id: 'tmdb://467244' }] },
  ] } }] as [RegExp, unknown]
}
const MOVIE_SEARCH: [RegExp, unknown] = [/search\/titles/, { results: [
  { id: 'M1', kind: 'movie', metadata: 'h', card: { originalTitle: 'The Zone of Interest', titlesI18n: {}, year: 2023 } },
] }]
const MOVIE_META: [RegExp, unknown] = [/metadata@h/, { id: 'M1', title: 'The Zone of Interest', year: 2023,
  kind: 'movie', external_ids: [{ id: '467244', source: 'tmdb' }] }]
const PUSH_500: [RegExp, unknown, number] = [/sync\/push/, {}, 500]
const PUSH_401: [RegExp, unknown, number] = [/sync\/push/, {}, 401]

describe('syncRatingsFromPlex', () => {
  it('never polls an artist section', async () => {
    const { f, calls } = router([SECTIONS, NO_ITEMS])
    await syncRatingsFromPlex(deps(f))
    expect(calls.some(c => /sections\/8\/all/.test(c.url))).toBe(false)
    expect(calls.some(c => /sections\/2\/all/.test(c.url))).toBe(true)
  })

  it('pushes a movie rating to bingers, converting the scale', async () => {
    const { f, calls } = router([SECTIONS, ratedMovie(8), NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
    const r = await syncRatingsFromPlex(deps(f))
    expect(r.synced).toBe(1)
    const body = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body)
    expect(body.ops[0]).toMatchObject({ table: 'entries', pk: { entityKind: 'movie', entityId: 'M1' }, fields: { rating: 4 } })
  })

  it('records plex as the origin, so the rounded value is never written back', async () => {
    const { f } = router([SECTIONS, ratedMovie(9), NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
    await syncRatingsFromPlex(deps(f))
    const link = store.getRatingLink('movie', 'M1')!
    expect(link.origin).toBe('plex')
    expect(link.plexRating).toBe(9)     // the ORIGINAL half-star, not the rounded one
    expect(link.bingersRating).toBe(5)
  })

  it('marks a show rating unsupported ONCE and never re-reports it', async () => {
    const SHOW = [/sections\/1\/all/, { MediaContainer: { Metadata: [
      { ratingKey: '86710', type: 'show', title: 'Squid Game', userRating: 9, lastRatedAt: 1764531685, Guid: [] },
    ] } }] as [RegExp, unknown]
    const { f } = router([SECTIONS, SHOW, NO_ITEMS, PUSH_OK])
    const r1 = await syncRatingsFromPlex(deps(f))
    expect(r1.unsupported).toBe(1)
    expect(store.isUnratable('86710')).toBe(true)
    const before = store.listFailures().length
    const r2 = await syncRatingsFromPlex(deps(f))
    expect(r2.unsupported).toBe(0)
    expect(store.listFailures().length).toBe(before)
  })

  it('does not re-push a rating it has already mirrored', async () => {
    const { f, calls } = router([SECTIONS, ratedMovie(8), NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
    await syncRatingsFromPlex(deps(f))
    const n = calls.filter(c => /sync\/push/.test(c.url)).length
    const r2 = await syncRatingsFromPlex(deps(f))
    expect(calls.filter(c => /sync\/push/.test(c.url)).length).toBe(n)
    // The second run must reach the already-mirrored guard, not fall over
    // earlier -- an unresolved or failed second run also pushes nothing.
    expect(r2.ignored).toBe(1)
  })

  it('writes nothing and records nothing under dry run', async () => {
    const d = { ...deps(router([SECTIONS, ratedMovie(8), NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK]).f), config: cfg({ DRY_RUN: 'true' }) }
    const r = await syncRatingsFromPlex(d as any)
    expect(r.synced).toBe(0)
    // The would-be push is counted: without this the test passes just as
    // well when the movie never resolved at all and there was nothing to push.
    expect(r.ignored).toBe(1)
    expect(store.getRatingLink('movie', 'M1')).toBeNull()
    expect(store.listFailures()).toHaveLength(0)
  })

  it('advances the per-section cursor so the next run is incremental', async () => {
    const { f } = router([SECTIONS, ratedMovie(8), NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
    await syncRatingsFromPlex(deps(f))
    expect(Number(store.getCursor('__rated_at:2'))).toBe(1764000001)
  })

  // Fix round 2, Ruling A: the cursor may only advance past TERMINAL outcomes.
  // The poll filter is strictly `>`, so committing past a retryable item would
  // mean it is never seen again -- even though a NEWER item on the same poll
  // already reached a terminal (synced) outcome.
  describe('the cursor only advances past terminal outcomes (fix round 2, Ruling A)', () => {
    const RETRYABLE_AND_TERMINAL_MOVIES: [RegExp, unknown] = [/sections\/2\/all/, { MediaContainer: { Metadata: [
      // Newest first, matching Plex's own lastRatedAt:desc sort.
      { ratingKey: '90001', type: 'movie', title: 'No Guid Yet', userRating: 8, lastRatedAt: 2000, Guid: [] },
      { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 8, lastRatedAt: 1000,
        Guid: [{ id: 'tmdb://467244' }] },
    ] } }]

    it('holds the cursor back at the retryable item even though a newer item on the same poll synced', async () => {
      const { f } = router([SECTIONS, RETRYABLE_AND_TERMINAL_MOVIES, NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
      const r = await syncRatingsFromPlex(deps(f))
      // Asserted first so this test stands on its own as a cursor guard: a
      // future counter rename must not let it trip on r.unresolved before it
      // ever reaches the assertion that actually matters here.
      // blockedAt (2000) - 1: NOT maxSeen (1000), and NOT 2000 itself -- the
      // retryable item must still be > cursor on the next poll.
      expect(store.getCursor('__rated_at:2')).toBe('1999')
      expect(r.unresolved).toBe(1)
      expect(r.synced).toBe(1)
    })

    // O2 (fix round 4): a section a retryable item legitimately pins must
    // still be VISIBLE -- not just correctly non-advancing. One row per
    // section per run (not per item, which would flood the table on every
    // poll), so Task 7's /health can surface a cursor stalled for runs on end.
    it('records exactly one failure row for a section a retryable item pins the cursor on', async () => {
      const { f } = router([SECTIONS, RETRYABLE_AND_TERMINAL_MOVIES, NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
      await syncRatingsFromPlex(deps(f))
      const rows = store.listFailures()
      expect(rows).toHaveLength(1)
      expect(rows[0]!.source).toBe('ratings')
      expect(rows[0]!.reason).toContain('section 2')
    })

    // O3 (fix round 4): a retryable item with lastRatedAt <= 0 (Plex omitted
    // it, or reported the epoch) used to set blockedAt = 0, making
    // limit = blockedAt - 1 = -1, which is never > since -- wedging the
    // WHOLE section's cursor forever, even for other items that synced fine
    // in the very same run.
    it('a lastRatedAt <= 0 item is ignored and never wedges the section cursor', async () => {
      const EPOCH_AND_NORMAL_MOVIES: [RegExp, unknown] = [/sections\/2\/all/, { MediaContainer: { Metadata: [
        // Newest first, matching Plex's own lastRatedAt:desc sort.
        { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 8, lastRatedAt: 9000,
          Guid: [{ id: 'tmdb://467244' }] },
        { ratingKey: '77777', type: 'movie', title: 'No Timestamp', userRating: 8, lastRatedAt: 0, Guid: [] },
      ] } }]
      const { f } = router([SECTIONS, EPOCH_AND_NORMAL_MOVIES, NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
      const r = await syncRatingsFromPlex(deps(f))
      expect(store.getCursor('__rated_at:2')).toBe('9000')
      expect(r.ignored).toBe(1)
      expect(r.synced).toBe(1)
    })

    const SHOW_TYPE2_ONLY: [RegExp, unknown] = [/sections\/1\/all\?type=2/, { MediaContainer: { Metadata: [
      { ratingKey: '86710', type: 'show', title: 'Squid Game', userRating: 9, lastRatedAt: 5000, Guid: [] },
    ] } }]
    // Section 2 (movie) is only ever polled with type=1, so this is unambiguous
    // and, unlike NO_ITEMS, does NOT also match section 1's type=4 request --
    // that one deliberately has NO route and falls through to router()'s
    // default 404, so fetchRatedSince throws for it.
    const SECTION2_TYPE1_EMPTY: [RegExp, unknown] = [/sections\/2\/all\?type=1/, { MediaContainer: { Metadata: [] } }]

    it('blocks the WHOLE section cursor when one type errors, even though the other type succeeded', async () => {
      const { f } = router([SECTIONS, SHOW_TYPE2_ONLY, SECTION2_TYPE1_EMPTY])
      const r = await syncRatingsFromPlex(deps(f))
      expect(r.unsupported).toBe(1) // the type=2 show rating still gets processed
      expect(r.failed).toBe(1) // the type=4 poll 404'd -- ONE incident, counted once
      expect(store.getCursor('__rated_at:1')).toBeNull() // no commit for the section at all
    })
  })

  // Fix round 2, Ruling C: 'queued' and 'halted' both durably enqueue the op
  // (src/outbox.ts's enqueueOps runs on every path returning either), so both
  // must be treated as success for the rating_link -- skipping it would let
  // Task 5 see origin===null and round-trip the rounded value back over Plex.
  describe('submit outcomes other than sent (fix round 2, Ruling C)', () => {
    it('treats a queued push (bingers unreachable) as success: link written, synced counted, cursor advanced', async () => {
      const { f } = router([SECTIONS, ratedMovie(8), NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_500])
      const r = await syncRatingsFromPlex(deps(f))
      expect(r.synced).toBe(1)
      expect(store.getRatingLink('movie', 'M1')?.origin).toBe('plex')
      expect(store.outboxDepth()).toBe(1) // durably queued; flushOutbox will deliver it
      expect(store.getCursor('__rated_at:2')).toBe('1764000001')
    })

    it('aborts the whole run on a halted gate: links the triggering op but never resolves the next item, and withholds the cursor', async () => {
      const TWO_MOVIES: [RegExp, unknown] = [/sections\/2\/all/, { MediaContainer: { Metadata: [
        { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 8, lastRatedAt: 1764000001,
          Guid: [{ id: 'tmdb://467244' }] },
        { ratingKey: '99999', type: 'movie', title: 'Never Reached', userRating: 8, lastRatedAt: 1000000000,
          Guid: [{ id: 'tmdb://999999' }] },
      ] } }]
      const { f, calls } = router([SECTIONS, TWO_MOVIES, NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_401])
      const d = deps(f)
      const r = await syncRatingsFromPlex(d)
      expect(r.synced).toBe(1)
      expect(store.getRatingLink('movie', 'M1')?.origin).toBe('plex')
      expect(store.outboxDepth()).toBe(1) // the halted op IS durably enqueued (src/outbox.ts:129/:136-138)
      expect(d.gate.halted).toBe(true)
      // The second item must never even be resolved once the gate halts.
      expect(calls.filter(c => /search\/titles/.test(c.url)).length).toBe(1)
      expect(store.getCursor('__rated_at:2')).toBeNull()
    })

    // Fix round 3: syncRatingsFromPlex built its SyncDeps without notifyUrl,
    // so haltGate()'s own notify() call was a silent no-op for every 401
    // raised during rating sync -- a write gate could close, get recorded in
    // `failures`, and tell nobody. Assert on the actual notify request the
    // mocked fetch received, not on a constant.
    it('a 401 from the rating push notifies the configured NOTIFY_URL', async () => {
      const { f, calls } = router([SECTIONS, ratedMovie(8), NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_401])
      const d = { ...deps(f), config: cfg({ NOTIFY_URL: 'http://hook' }) }
      await syncRatingsFromPlex(d)
      const notified = calls.find(c => c.url === 'http://hook')
      expect(notified).toBeDefined()
      expect(JSON.parse(notified!.init.body).text).toMatch(/writes halted/)
    })
  })

  // Fix round 2, Ruling B: DRY_RUN must write nothing durable, anywhere --
  // not the cursor, not markUnratable/recordFailure, not the rating link,
  // and (fix round 4, O1) not a real notification either. Section 1's
  // type=4 poll is deliberately left unmocked (falls through to router()'s
  // default 404) so out.failed > 0 even under dry run, making the notify
  // assertion below meaningful rather than vacuously true.
  it('a dry run over a mix of outcomes leaves the cursor, failures, unratable marks, rating links, and notifications untouched', async () => {
    const SHOW_TYPE2_ONLY: [RegExp, unknown] = [/sections\/1\/all\?type=2/, { MediaContainer: { Metadata: [
      { ratingKey: '86710', type: 'show', title: 'Squid Game', userRating: 9, lastRatedAt: 1764531685, Guid: [] },
    ] } }]
    const { f, calls } = router([SECTIONS, SHOW_TYPE2_ONLY, ratedMovie(8), MOVIE_SEARCH, MOVIE_META])
    const d = { ...deps(f), config: cfg({ DRY_RUN: 'true', NOTIFY_URL: 'http://hook' }) }
    const r = await syncRatingsFromPlex(d as any)
    expect(r.unsupported).toBe(1)
    expect(r.synced).toBe(0)
    expect(r.failed).toBe(1) // section 1's type=4 poll 404'd -- one incident
    expect(store.getCursor('__rated_at:1')).toBeNull()
    expect(store.getCursor('__rated_at:2')).toBeNull()
    expect(store.listFailures()).toHaveLength(0)
    expect(store.isUnratable('86710')).toBe(false)
    expect(store.getRatingLink('movie', 'M1')).toBeNull()
    expect(calls.some(c => c.url === 'http://hook')).toBe(false) // no real POST despite a real failure
  })

  // Final review, finding 1: the R5 rule ("one incident counts once; the rows
  // it blocked are not counted as failures of their own") was applied to
  // toPlex in 42547cc and never back-ported here. Three sections down
  // reported `failed: 5` -- one per (section, type) request -- and notified
  // "5 failure(s)" for one event.
  describe('a plex poll outage is ONE incident (final review, finding 1)', () => {
    it('counts one failure and records one row when every section poll fails', async () => {
      // Only /library/sections is routed: all three section polls (1/type=4,
      // 1/type=2, 2/type=1) fall through to router()'s default 404.
      const { f } = router([SECTIONS])
      const r = await syncRatingsFromPlex(deps(f))
      expect(r.failed).toBe(1)
      expect(store.listFailures().filter(x => /rating poll failed/.test(x.reason))).toHaveLength(1)
      // Still blocked in full: neither section may commit a cursor.
      expect(store.getCursor('__rated_at:1')).toBeNull()
      expect(store.getCursor('__rated_at:2')).toBeNull()
    })

    // RR5: deduplicating per RUN would swallow a second, genuinely different
    // failure entirely -- neither counted nor recorded. The dedup key is the
    // incident (here: the HTTP status), not the run.
    it('counts two genuinely different poll failures as two incidents', async () => {
      // Section 1's polls 500; section 2's poll is unrouted and 404s.
      const { f } = router([SECTIONS, [/sections\/1\/all/, {}, 500]])
      const r = await syncRatingsFromPlex(deps(f))
      expect(r.failed).toBe(2)
      const rows = store.listFailures().filter(x => /rating poll failed/.test(x.reason))
      expect(rows).toHaveLength(2)
      expect(rows.some(x => /500/.test(x.reason))).toBe(true)
      expect(rows.some(x => /404/.test(x.reason))).toBe(true)
    })

    it('notifies about one failure, not one per blocked poll', async () => {
      const { f, calls } = router([SECTIONS])
      await syncRatingsFromPlex({ ...deps(f), config: cfg({ NOTIFY_URL: 'http://hook' }) })
      const notified = calls.find(c => c.url === 'http://hook')
      expect(JSON.parse(notified!.init.body).text).toBe('rating sync: 1 failure(s)')
    })
  })

  // Final review, finding 2. src/resolve.ts:15 defines `retryable` and its own
  // comment says the two cases "must never be conflated" -- but fromPlex
  // treated EVERY resolve failure as retryable. One plex-rated item bingers'
  // catalogue genuinely lacks then pinned its section cursor permanently, so
  // every newer rating in that section stopped syncing forever while the run
  // re-issued the same doomed search and appended a failures row each time.
  describe('a confirmed no-match is terminal (final review, finding 2)', () => {
    // tmdb 000000 is NOT what MOVIE_META reports (467244), so resolveTitle
    // checks every candidate and returns a plain `no external id match` --
    // non-retryable, a real answer rather than an upstream error.
    const NO_MATCH_MOVIE: [RegExp, unknown] = [/sections\/2\/all/, { MediaContainer: { Metadata: [
      { ratingKey: '55555', type: 'movie', title: 'Home Video', userRating: 8, lastRatedAt: 999,
        Guid: [{ id: 'tmdb://000000' }] },
    ] } }]

    it('lets the section cursor PAST an item bingers genuinely does not have', async () => {
      const { f } = router([SECTIONS, NO_MATCH_MOVIE, NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
      const r = await syncRatingsFromPlex(deps(f))
      expect(r.unsupported).toBe(1)
      expect(r.unresolved).toBe(0)
      // The reproduction was a cursor stuck at 999 across three runs.
      expect(store.getCursor('__rated_at:2')).toBe('999')
      expect(store.isUnratable('55555')).toBe(true)
    })

    it('reports it ONCE and never re-issues the catalogue search for it', async () => {
      const { f, calls } = router([SECTIONS, NO_MATCH_MOVIE, NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
      await syncRatingsFromPlex(deps(f))
      const failuresAfterFirst = store.listFailures().length
      const searchesAfterFirst = calls.filter(c => /search\/titles/.test(c.url)).length
      expect(failuresAfterFirst).toBe(1)
      expect(searchesAfterFirst).toBeGreaterThan(0)

      const r2 = await syncRatingsFromPlex(deps(f))
      expect(r2.unsupported).toBe(0)
      expect(r2.ignored).toBe(1) // seen, recognised as already marked, skipped
      expect(store.listFailures().length).toBe(failuresAfterFirst)
      expect(calls.filter(c => /search\/titles/.test(c.url)).length).toBe(searchesAfterFirst)
    })

    // RR2. `terminal for this run` is not `terminal forever`: bingers'
    // catalogue is a third-party dataset that gains entries continuously, so
    // anything rated in Plex before the catalogue carries it -- most new
    // releases -- would otherwise never sync, ever.
    describe('the mark expires, so a catalogue that later gains the title syncs (RR2)', () => {
      // Run 2's catalogue DOES carry tmdb 000000 now. Same search hit (M1),
      // whose metadata now reports the id the plex item actually has.
      const MATCHING_META: [RegExp, unknown] = [/metadata@h/, { id: 'M1', title: 'Home Video', year: 2024,
        kind: 'movie', external_ids: [{ id: '000000', source: 'tmdb' }] }]

      const markIt = async () => {
        const { f } = router([SECTIONS, NO_MATCH_MOVIE, NO_ITEMS, MOVIE_SEARCH, MOVIE_META, PUSH_OK])
        const r = await syncRatingsFromPlex(deps(f))
        expect(r.unsupported).toBe(1)
        expect(store.isUnratable('55555')).toBe(true)
      }

      it('is still trusted INSIDE the recheck window, even once the catalogue matches', async () => {
        await markIt()
        const { f, calls } = router([SECTIONS, NO_MATCH_MOVIE, NO_ITEMS, MOVIE_SEARCH, MATCHING_META, PUSH_OK])
        const r = await syncRatingsFromPlex(deps(f)) // default UNRATABLE_RECHECK_HOURS
        expect(r.synced).toBe(0)
        expect(r.ignored).toBe(1)
        expect(calls.some(c => /search\/titles/.test(c.url))).toBe(false)
      })

      it('is re-checked PAST the recheck window, and the rating finally syncs', async () => {
        await markIt()
        const { f } = router([SECTIONS, NO_MATCH_MOVIE, NO_ITEMS, MOVIE_SEARCH, MATCHING_META, PUSH_OK])
        const d = { ...deps(f), config: cfg({ UNRATABLE_RECHECK_HOURS: '0' }) }
        const r = await syncRatingsFromPlex(d)
        expect(r.synced).toBe(1)
        expect(r.ignored).toBe(0)
        expect(store.getRatingLink('movie', 'M1')?.origin).toBe('plex')
      })

      // A show rating is structurally unsupported: no catalogue update will
      // give bingers a show-level rating, so re-reporting it every week would
      // be pure noise in a `failures` table that has no pruning.
      it('never expires for a show rating, which no catalogue update can change', async () => {
        const SHOW: [RegExp, unknown] = [/sections\/1\/all/, { MediaContainer: { Metadata: [
          { ratingKey: '86710', type: 'show', title: 'Squid Game', userRating: 9, lastRatedAt: 5000, Guid: [] },
        ] } }]
        const { f } = router([SECTIONS, SHOW, NO_ITEMS, PUSH_OK])
        const r1 = await syncRatingsFromPlex(deps(f))
        expect(r1.unsupported).toBe(1)
        const before = store.listFailures().length

        const d = { ...deps(f), config: cfg({ UNRATABLE_RECHECK_HOURS: '0' }) }
        const r2 = await syncRatingsFromPlex(d)
        expect(r2.unsupported).toBe(0)
        expect(store.listFailures().length).toBe(before)
      })
    })

    // The other half of honouring the flag: an upstream error is NOT an
    // answer. src/resolve.ts's search failure had no `retryable` marker, so
    // honouring the flag naively would have turned a network blip into a
    // permanent unratable mark -- the exact conflation the flag forbids.
    it('still treats an upstream search failure as retryable, never as a no-match', async () => {
      const SEARCH_500: [RegExp, unknown, number] = [/search\/titles/, {}, 500]
      const { f } = router([SECTIONS, NO_MATCH_MOVIE, NO_ITEMS, SEARCH_500])
      const r = await syncRatingsFromPlex(deps(f))
      expect(r.unresolved).toBe(1)
      expect(r.unsupported).toBe(0)
      expect(store.isUnratable('55555')).toBe(false)
      // blockedAt (999) - 1: the cursor is held BELOW the retryable item, so
      // the strictly-`>` poll filter still returns it on the next run.
      expect(store.getCursor('__rated_at:2')).toBe('998')
    })
  })

  // Final review, finding 7: one fetchShowIds request per RATED EPISODE, where
  // toPlex.leavesFor() already memoises per show.
  it('fetches a show\'s external ids once per run, not once per rated episode', async () => {
    const TWO_EPISODES: [RegExp, unknown] = [/sections\/1\/all\?type=4/, { MediaContainer: { Metadata: [
      { ratingKey: '1001', type: 'episode', title: 'Ep 3', userRating: 8, lastRatedAt: 3000,
        grandparentRatingKey: '90363', parentIndex: 1, index: 3, Guid: [] },
      { ratingKey: '1002', type: 'episode', title: 'Ep 4', userRating: 8, lastRatedAt: 2000,
        grandparentRatingKey: '90363', parentIndex: 1, index: 4, Guid: [] },
    ] } }]
    const SHOW_IDS: [RegExp, unknown] = [/metadata\/90363\?includeGuids/,
      { MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://247522' }] }] } }]
    // The title resolve then 500s, so both episodes end `unresolved` -- which
    // is beside the point here: the assertion is on the SHOW lookup count.
    const SEARCH_500: [RegExp, unknown, number] = [/search\/titles/, {}, 500]
    const { f, calls } = router([SECTIONS, TWO_EPISODES, NO_ITEMS, SHOW_IDS, SEARCH_500])
    const r = await syncRatingsFromPlex(deps(f))
    expect(r.unresolved).toBe(2)
    expect(calls.filter(c => /metadata\/90363\?includeGuids/.test(c.url))).toHaveLength(1)
  })
})
