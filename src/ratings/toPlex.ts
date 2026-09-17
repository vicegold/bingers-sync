import { bingersToPlex, plexToBingers } from './scale.js'
import { fetchSections, fetchSectionGuidIndex, fetchShowIds, fetchAllLeaves, setPlexRating, type SectionIndexEntry, type PlexEpisode } from '../plex/client.js'
import { intersects } from '../resolve.js'
import { notify } from '../notify.js'
import type { RatingDeps } from './fromPlex.js'

const SOURCES = ['tmdb', 'tvdb', 'imdb'] as const

/**
 * `written`  the rating was pushed to plex and rating_link now records bingers
 *            as the origin
 * Two kinds of refusal, counted and reported SEPARATELY -- one number would
 * make a steady state and a caught data loss indistinguishable on /health,
 * and it is the second whose rate an operator actually needs:
 *
 * `refusedOrigin`   LAYER 1 -- a known rating_link says plex authored this
 *            rating AND bingers still holds exactly the value we mirrored
 *            from plex, so there is nothing of our own to contribute. A
 *            permanent STEADY STATE for most of the library: counted and
 *            summarised once per run rather than logged per item. Its one
 *            load-bearing job is the rating the user CLEARED in plex --
 *            entry.userRating is then null, Layer 2's guard is
 *            `!= null && ...` so it falls through, and the stale bingers
 *            value would resurrect a rating the user deliberately removed.
 *            It also defers a genuine bingers change while an unconfirmed
 *            push for that entity still sits in the outbox.
 * `refusedHalfStar` LAYER 2 -- plex's current live rating is ODD (a
 *            half-star) and already rounds down to the bingers value we
 *            hold, but bingers' rating may have genuinely changed since --
 *            writing the new target would inflate that half-star. A real
 *            EVENT: the guard catching an actual loss. Rare, actionable,
 *            logged per item unconditionally (not just under DRY_RUN),
 *            because in a live run the log is its only observable trace.
 * `skipped`  terminal, a true no-op: plex's current live rating is EVEN and
 *            already numerically equals bingersToPlex(row.rating). Writing
 *            would change nothing, so staying quiet is correct. Also covers
 *            DRY_RUN: a would-be write that is only logged.
 * `unmapped` no plex item could be verified via a shared external id -- either
 *            bingers has no external ids cached for the title, no item in the
 *            scanned plex section carries a matching Guid, an episode's show
 *            has no durably-cached local ratingKey yet (no scrobble has ever
 *            recorded one), that cached ratingKey no longer verifies against
 *            a shared external id in THIS run (stale cache, rebuilt library,
 *            a different server, or a poisoned webhook -- see leavesFor()),
 *            no leaf in that show's allLeaves matches its season/number, or
 *            the section/allLeaves scan itself failed this run so nothing
 *            could be checked. Never guessed from title/year.
 * `failed`   plex explicitly rejected a rating write, or a section/show scan
 *            itself failed (network error, 401, Plex down) -- counted ONCE
 *            per incident (once for the movie section scan, once per show
 *            whose ratingKey verification or allLeaves fetch failed), not
 *            once per row it blocked (those rows are `unmapped`: their plex
 *            state could not be determined at all)
 */
export type RatingToPlexResult = {
  written: number; refusedOrigin: number; refusedHalfStar: number
  skipped: number; unmapped: number; failed: number
}

/**
 * Plex cannot be searched by external id (`/library/all?guid=...` returns size 0),
 * so a movie's local ratingKey -- and its CURRENT live rating -- is found by
 * scanning its section once and matching on the Guid array each item carries.
 * Deliberately unfiltered (see fetchSectionGuidIndex): an unrated movie -- exactly
 * what this direction needs to find -- would be excluded by any lastRatedAt filter.
 */
async function movieIndex(deps: RatingDeps): Promise<Map<string, SectionIndexEntry>> {
  const pd = { plexUrl: deps.config.plexUrl, plexToken: deps.config.plexToken, fetchImpl: deps.fetchImpl }
  const merged = new Map<string, SectionIndexEntry>()
  for (const sec of await fetchSections(pd)) {
    if (sec.type !== 'movie') continue
    for (const [guid, entry] of await fetchSectionGuidIndex(pd, sec.key, 1)) {
      if (!merged.has(guid)) merged.set(guid, entry)
    }
  }
  return merged
}

function lookup(index: Map<string, SectionIndexEntry>, ids: Record<string, string>): SectionIndexEntry | null {
  for (const s of SOURCES) {
    const v = ids[s]
    if (v) { const e = index.get(`${s}://${v}`); if (e) return e }
  }
  return null
}

export async function syncRatingsToPlex(deps: RatingDeps): Promise<RatingToPlexResult> {
  const out: RatingToPlexResult = { written: 0, refusedOrigin: 0, refusedHalfStar: 0, skipped: 0, unmapped: 0, failed: 0 }
  const pd = { plexUrl: deps.config.plexUrl, plexToken: deps.config.plexToken, fetchImpl: deps.fetchImpl }
  const dryRun = deps.config.dryRun

  // The section scan is attempted at most once per run, on the first movie
  // row that needs it, and its outcome (success or failure) is cached: a
  // failure here means every remaining movie row this run cannot be checked
  // against Plex at all, not that it should retry the same doomed request.
  // The failure itself is counted here, exactly ONCE -- one Plex outage is
  // one incident, not one per row it happens to block. Every row blocked by
  // it is counted `unmapped` by the caller instead: its plex state simply
  // could not be determined this run.
  let movies: Map<string, SectionIndexEntry> | null = null
  let moviesFailed = false
  async function getMovies(): Promise<Map<string, SectionIndexEntry> | null> {
    if (movies) return movies
    if (moviesFailed) return null
    try {
      movies = await movieIndex(deps)
      return movies
    } catch (e) {
      moviesFailed = true
      out.failed++
      // A durable local write, suppressed under DRY_RUN like every other one.
      if (!dryRun) deps.store.recordFailure('ratings', `plex section scan failed: ${(e as Error).message}`, {})
      return null
    }
  }

  // Per-show cache of VERIFIED allLeaves, keyed by titleId. A show's cached
  // local ratingKey (src/handlers.ts's __plex_show:, populated from whatever
  // grandparentRatingKey a scrobble carried) is server-local and
  // reassignable -- a library rebuild, a repointed PLEX_URL, or a second
  // server can make it stale without it ever being written wrong, and
  // /plex has no shared secret, so an attacker-supplied grandparentRatingKey
  // could otherwise become a durable value steering a later outbound write.
  // Trusting it unverified is the hazard Task 5 closed by deleting the
  // link?.plexRatingKey shortcut, arriving through a different door.
  // Re-verifying it here -- via a shared external id, in THIS run -- turns a
  // stale or poisoned cache entry into a no-op instead of a write landing on
  // the wrong show. Resolved (fetch + verify) at most ONCE per show per run,
  // and the negative outcome is cached too, so a show that fails
  // verification or whose fetch fails is not retried for every remaining
  // episode of that show. Mirrors getMovies()'s shape (cached map / cached
  // failure) rather than inventing a second idiom.
  const showLeaves = new Map<string, PlexEpisode[] | null>()
  async function leavesFor(titleId: string): Promise<PlexEpisode[] | null> {
    if (showLeaves.has(titleId)) return showLeaves.get(titleId)!
    const showKey = deps.store.showRatingKeyFor(titleId)
    if (!showKey) { showLeaves.set(titleId, null); return null }
    const { ids } = deps.store.externalIdsFor(titleId)
    if (Object.keys(ids).length === 0) { showLeaves.set(titleId, null); return null }
    let showIds: Awaited<ReturnType<typeof fetchShowIds>>
    try {
      showIds = await fetchShowIds(pd, showKey)
    } catch (e) {
      out.failed++
      if (!dryRun) deps.store.recordFailure('ratings', `plex show lookup failed for ${titleId} (ratingKey ${showKey}): ${(e as Error).message}`, {})
      showLeaves.set(titleId, null)
      return null
    }
    if (!intersects(showIds, ids)) {
      // Two different situations, kept distinct the way this codebase
      // already separates `unresolved` from `deferred` elsewhere -- never
      // conflated into one event:
      const overlap = SOURCES.some(s => ids[s] != null && showIds[s] != null)
      if (overlap) {
        // PROVABLY a different show: some source id both sides carry
        // disagrees. Repairing the cache would mean guessing a replacement
        // key -- never do that -- but deleting it is not a guess, it is
        // discarding a value just verified false. The next scrobble for the
        // real show repopulates it correctly from the webhook. Left in
        // place, a stale entry would burn a fetchShowIds and emit an
        // identical failure row every run, forever.
        if (!dryRun) {
          deps.store.recordFailure('ratings',
            `cached show ratingKey ${showKey} for ${titleId} denotes a different show -- external ids disagree, clearing the cache entry`, {})
          deps.store.deleteShowRatingKey(titleId)
        }
      } else {
        // Cannot tell yet: no source id either side carries in common with
        // the other, so nothing here PROVES the cache wrong -- it may well
        // still be correct. Record why, but leave the entry alone.
        if (!dryRun) {
          deps.store.recordFailure('ratings',
            `cached show ratingKey ${showKey} for ${titleId} could not be verified -- no shared external id source to compare`, {})
        }
      }
      showLeaves.set(titleId, null)
      return null
    }
    try {
      const leaves = await fetchAllLeaves(pd, showKey)
      showLeaves.set(titleId, leaves)
      return leaves
    } catch (e) {
      out.failed++
      if (!dryRun) deps.store.recordFailure('ratings', `allLeaves failed for show ${titleId} (ratingKey ${showKey}): ${(e as Error).message}`, {})
      showLeaves.set(titleId, null)
      return null
    }
  }

  for (const row of deps.store.ratedEntries()) {
    const link = deps.store.getRatingLink(row.entityKind, row.entityId)

    // Layer 1: plex authored this rating AND the user has not changed it in
    // bingers since -- bingers holds exactly the value we mirrored out of
    // plex, so we have nothing of our own to contribute and must not write.
    //
    // Deliberately NOT "refuse anything plex ever authored": that link never
    // re-originates, so a rating the user later changes in bingers could
    // never reach plex again. When row.rating differs from link.bingersRating
    // the user DID change it, and Layer 2 below decides -- it still protects
    // the half-star, and it honours a genuine change.
    //
    // The pending-op check is what keeps that narrowing safe. src/outbox.ts
    // mirrors a rating into sync_state only when bingers CONFIRMS it, so
    // while a plex->bingers push is queued (bingers unreachable, or the write
    // gate halted) row.rating is the pre-push value and differs from
    // link.bingersRating for a reason that has nothing to do with the user.
    // Without it, that window would let the stale value be written back over
    // the very plex rating it was derived from -- a fourth inflation bug.
    if (link?.origin === 'plex'
      && (link.bingersRating === row.rating || deps.store.hasPendingRatingOp(row.entityKind, row.entityId))) {
      out.refusedOrigin++
      continue
    }

    const target = bingersToPlex(row.rating)

    // Resolve the plex item via verified external-id intersection. A missing
    // or absent rating_link is NEVER treated as permission to write -- the
    // link is derived bookkeeping and can be absent (pre-existing data, an
    // unresolved/failed fromPlex.ts pass, a non-positive lastRatedAt item),
    // stale, or simply wrong. Only a freshly-scanned, LIVE plex value is
    // trusted for the "nothing to do" decision below.
    let entry: SectionIndexEntry | null = null
    if (row.entityKind === 'movie') {
      // titleId is null for episodes (see store.ratedEntries) -- falling back
      // to entityId there would look up title_map by an episode id, which
      // never matches, and correctly yields {} rather than a wrong mapping.
      const { ids } = deps.store.externalIdsFor(row.titleId ?? row.entityId)
      if (Object.keys(ids).length === 0) { out.unmapped++; continue }
      const idx = await getMovies()
      if (!idx) { out.unmapped++; continue }
      entry = lookup(idx, ids)
    } else {
      // An episode's local ratingKey is only reachable through its show: plex
      // cannot be queried by external id, and episode_map holds only
      // position. leavesFor() does the verified show resolution (see above).
      const pos = deps.store.episodePosition(row.entityId)
      if (pos) {
        const leaves = await leavesFor(pos.titleId)
        const leaf = leaves?.find(l => l.season === pos.season && l.number === pos.number)
        // userRating carries through so Layer 2 protects episodes exactly as
        // it protects movies. Dropping it here would silently disable the
        // half-star guard for every episode.
        if (leaf) entry = { ratingKey: leaf.ratingKey, userRating: leaf.userRating }
      }
    }
    if (!entry) { out.unmapped++; continue }

    // Layer 2, and the fix for the data-loss path this whole block replaces:
    // compare against plex's ACTUAL CURRENT rating, never our own bookkeeping.
    // If it already rounds down to the bingers value we hold, writing
    // bingersToPlex(row.rating) back would risk inflating an odd (half-star)
    // plex value by one full star -- the destructive round trip this feature
    // exists to prevent. The predicate for declining is the same either way;
    // what differs is whether declining actually changes anything:
    //   target === entry.userRating  ->  an EVEN plex value: writing target
    //     would be a byte-for-byte no-op. True nothing-to-do, stay quiet.
    //   target !== entry.userRating  ->  an ODD plex value (the round trip
    //     is lossy: bingersToPlex(plexToBingers(odd)) === odd + 1). Bingers'
    //     rating may have genuinely changed since this was last observed --
    //     the guard is ACTIVELY declining a real write, not deduplicating,
    //     and that must be visible the same way the origin refusal above is.
    if (entry.userRating != null && plexToBingers(entry.userRating) === row.rating) {
      if (target === entry.userRating) {
        out.skipped++
      } else {
        console.log(`[refused] ${row.entityKind} ${row.entityId} bingers rating ${row.rating} already rounds to plex's current ${entry.userRating}, declining to overwrite the half-star`)
        out.refusedHalfStar++
      }
      continue
    }

    if (dryRun) {
      console.log(`[DRY_RUN] would set plex rating ${target} on ${row.entityKind} ${row.entityId} (ratingKey ${entry.ratingKey})`)
      out.skipped++
      continue
    }

    try {
      await setPlexRating(pd, entry.ratingKey, target)
    } catch (e) {
      deps.store.recordFailure('ratings', `plex rate failed for ${row.entityId}: ${(e as Error).message}`, row)
      out.failed++
      continue
    }

    deps.store.putRatingLink({
      entityKind: row.entityKind, entityId: row.entityId,
      bingersRating: row.rating, plexRating: target, plexRatingKey: entry.ratingKey, origin: 'bingers',
    })
    out.written++
  }

  // Layer 1 fires on a steady state, not on an event: once plex has authored
  // a rating, the link says so forever. One line per item per run meant 25
  // identical lines announcing that nothing changed, drowning the Layer 2
  // lines that ARE events. One summary line for the whole steady state.
  if (out.refusedOrigin) {
    console.log(`[refused] ${out.refusedOrigin} rating(s) originated in plex and are unchanged in bingers; nothing to write back`)
  }

  if (out.failed && !dryRun) await notify(deps.config.notifyUrl, `rating sync to plex: ${out.failed} failure(s)`, deps.fetchImpl)
  return out
}
