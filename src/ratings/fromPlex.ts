import { randomUUID } from 'node:crypto'
import type { Config } from '../config.js'
import type { Store } from '../store.js'
import type { Auth } from '../bingers/auth.js'
import type { Gate } from '../outbox.js'
import { submit } from '../outbox.js'
import { notify } from '../notify.js'
import { plexToBingers } from './scale.js'
import { fetchSections, fetchRatedSince, fetchShowIds, parseGuids, type PlexRatedItem } from '../plex/client.js'
import { resolveTitle, resolveEpisode, type ExternalIds } from '../resolve.js'

export type RatingDeps = {
  config: Config; store: Store; auth: Auth; gate: Gate
  fetchImpl?: typeof fetch; newId?: () => string
}

export const ratingCursorKey = (sectionKey: string) => `__rated_at:${sectionKey}`

/**
 * `synced`      the rating landed, or is durably queued/enqueued for delivery
 * `unsupported` bingers cannot represent this rating at all -- a show rating,
 *               or an item bingers' catalogue CONFIRMED it does not have --
 *               reported once, then permanently marked (see `unratable`) so
 *               neither the report nor the catalogue search repeats forever
 * `unresolved`  retryable: no external ids yet, or resolution failed
 *               transiently (src/resolve.ts's `retryable` flag, honoured --
 *               a confirmed no-match is `unsupported`, never this)
 * `ignored`     terminal, nothing to do: out-of-range rating, malformed item,
 *               already-mirrored no-op, already-marked-unratable item, or
 *               (under DRY_RUN) a would-be push
 * `failed`      bingers explicitly rejected the op, or plex could not be
 *               polled -- an outage counted ONCE per run, not once per
 *               (section, type) request it happened to block
 */
export type RatingSyncResult = { synced: number; unsupported: number; unresolved: number; ignored: number; failed: number }

export async function syncRatingsFromPlex(deps: RatingDeps): Promise<RatingSyncResult> {
  const out: RatingSyncResult = { synced: 0, unsupported: 0, unresolved: 0, ignored: 0, failed: 0 }
  const dryRun = deps.config.dryRun
  const pd = { plexUrl: deps.config.plexUrl, plexToken: deps.config.plexToken, fetchImpl: deps.fetchImpl }
  const rd = { store: deps.store, fetchImpl: deps.fetchImpl, searchMaxPages: deps.config.searchMaxPages }
  const newId = deps.newId ?? randomUUID

  async function finish(): Promise<RatingSyncResult> {
    // Guarded like every other durable/outbound action under DRY_RUN: a dry
    // run must not send a real notification for failures it only simulated.
    if (out.failed && !dryRun) await notify(deps.config.notifyUrl, `rating sync: ${out.failed} failure(s)`, deps.fetchImpl)
    return out
  }

  let sections
  try { sections = await fetchSections(pd) } catch { out.failed++; return finish() }

  // One lookup per SHOW, not one per rated episode of it. Mirrors
  // toPlex.leavesFor()'s per-show memo, including caching the NEGATIVE
  // outcome: a failing lookup is not re-issued for every remaining episode of
  // the same show -- those items stay `unresolved` and retry next run.
  const showIdsCache = new Map<string, ExternalIds>()
  async function showIdsFor(key: string): Promise<ExternalIds> {
    if (showIdsCache.has(key)) return showIdsCache.get(key)!
    const ids = await fetchShowIds(pd, key).catch(() => ({} as ExternalIds))
    showIdsCache.set(key, ids)
    return ids
  }

  // One Plex outage is ONE incident, not one per (section, type) poll it
  // blocked -- the same R5 rule already applied to toPlex's section scan in
  // 42547cc, back-ported here. Three sections down used to report `failed: 5`
  // (one per poll request) and notify "5 failure(s)" for a single event.
  // Every section whose poll failed is still blocked in full; only the count
  // and the failure row are deduplicated. The rows the outage blocked cannot
  // be counted `unresolved` the way toPlex counts its blocked rows
  // `unmapped`: a failed poll never told us which rows they were.
  //
  // Deduplicated per INCIDENT, not per run: a run-level flag would swallow a
  // second, genuinely different failure entirely -- neither counted nor
  // recorded. plexGet's message is `plex GET <path> -> <status>` and the path
  // is per-request by construction, so the status is what actually
  // distinguishes one failure from another. A transport error that never got
  // a response has no status and keys on its own message.
  const pollIncidents = new Set<string>()
  const incidentKey = (e: unknown) => {
    const msg = (e as Error).message
    const m = /-> (\d+)$/.exec(msg)
    return m ? `http ${m[1]}` : msg
  }

  // A confirmed no-match is terminal for the cursor, not terminal forever --
  // see UNRATABLE_RECHECK_HOURS. Computed once per run so every item in the
  // run is judged against the same instant.
  const unratableStaleBefore = new Date(Date.now() - deps.config.unratableRecheckHours * 3_600_000).toISOString()

  // Once a submit() call reports the write gate halted, every later submit()
  // in this run will halt too (the session is dead) -- so we stop touching
  // Plex/Bingers entirely rather than burning resolve calls for ops that can
  // only ever be locally enqueued from here on.
  let runHalted = false

  for (const sec of sections) {
    // Audiobooks have no bingers counterpart; only movie and show sections are polled.
    if (sec.type !== 'movie' && sec.type !== 'show') continue
    const cursorKey = ratingCursorKey(sec.key)
    const since = Number(deps.store.getCursor(cursorKey) ?? 0)
    // A show section is polled for EPISODES (type 4) and SHOWS (type 2); a
    // show row is recorded unsupported. Plex type 3 (season) is deliberately
    // NOT polled: a season rating has no bingers equivalent either, so asking
    // for it only to record it unsupported buys nothing.
    const types: (1 | 2 | 4)[] = sec.type === 'movie' ? [1] : [4, 2]

    // The cursor may only advance past items that reached a TERMINAL outcome.
    // fetchRatedSince sorts newest-first, so anything left unprocessed after an
    // abort is OLDER than everything already seen -- committing a max here
    // would make the strictly-`>` poll filter skip it forever. `maxSeen` tracks
    // the newest terminal lastRatedAt; `blockedAt` tracks the OLDEST retryable
    // one, because the cursor must never pass a retryable item even if a newer
    // one already succeeded.
    let maxSeen = since
    let blockedAt: number | null = null
    let sectionBlocked = false

    const markTerminal = (lastRatedAt: number) => { if (lastRatedAt > maxSeen) maxSeen = lastRatedAt }
    const markRetryable = (lastRatedAt: number) => {
      if (blockedAt === null || lastRatedAt < blockedAt) blockedAt = lastRatedAt
    }
    /**
     * A CONFIRMED no-match: src/resolve.ts checked and bingers' catalogue
     * genuinely has no such title or episode (its `retryable` flag absent --
     * "the two cases must never be conflated"). TERMINAL, and it has to be.
     * Held as retryable it pins this section's cursor below itself forever:
     * every NEWER rating in the section stops syncing permanently, while each
     * run re-issues the same doomed catalogue search and appends another
     * `failures` row. Losing the one item bingers cannot represent is
     * correct; losing every rating behind it is not.
     *
     * Marked unratable exactly the way an unsupported show rating is, so it
     * is reported ONCE rather than once per run, and the search behind it is
     * never re-issued (see the isUnratable check in the item loop below).
     * The mark is permanent by design; clearing the `unratable` row is how an
     * item bingers' catalogue later gains is given another chance.
     */
    const markNoMatch = (item: PlexRatedItem, reason: string) => {
      markTerminal(item.lastRatedAt)
      if (dryRun) {
        console.log(`[DRY_RUN] would mark ${item.type} ${item.ratingKey} (${item.title ?? ''}) unratable: ${reason}`)
      } else {
        deps.store.markUnratable(item.ratingKey, reason)
        deps.store.recordFailure('ratings', `${item.type} rating has no bingers match: ${item.title} -- ${reason}`,
          { ratingKey: item.ratingKey })
      }
      out.unsupported++
    }

    for (const t of types) {
      let items: PlexRatedItem[]
      try {
        items = await fetchRatedSince(pd, sec.key, t, since)
      } catch (e) {
        // A poll failure means we do not know what this type's window
        // contains. Letting the OTHER type's max commit the section's cursor
        // would silently skip everything in the failed type's window, so the
        // whole section is blocked rather than just this one type.
        sectionBlocked = true
        const key = incidentKey(e)
        if (!pollIncidents.has(key)) {
          pollIncidents.add(key)
          out.failed++
          // A durable local write, suppressed under DRY_RUN like every other one.
          if (!dryRun) {
            deps.store.recordFailure('ratings', `plex rating poll failed: ${(e as Error).message}`,
              { sectionKey: sec.key, type: t })
          }
        }
        continue
      }

      for (const item of items) {
        if (item.lastRatedAt <= 0) {
          // No usable ordering information (Plex omitted lastRatedAt
          // entirely, or reported the epoch). It can never be positioned in
          // the cursor scheme: letting it call markRetryable would set
          // blockedAt to 0, making limit = -1, which is never > since --
          // wedging the WHOLE section's cursor permanently, even when other
          // items in the same run synced fine. Treated as malformed input,
          // same bucket as the missing season/episode check below: terminal,
          // ignored, and never touches maxSeen/blockedAt at all.
          if (dryRun) console.log(`[DRY_RUN] ${item.type} ${item.ratingKey} has no usable lastRatedAt, ignoring`)
          out.ignored++
          continue
        }

        // Already marked unratable -- a show rating, or an item bingers'
        // catalogue confirmed it does not have. Terminal and silent, and it
        // has to come BEFORE any resolve: re-issuing the full catalogue
        // search for a known no-match on every single run is exactly what
        // this mark exists to stop. Past UNRATABLE_RECHECK_HOURS the mark
        // expires and the item IS re-checked, because "bingers' catalogue
        // does not have this" is a statement about a dataset that keeps
        // growing, not a permanent property of the item.
        if (deps.store.isUnratable(item.ratingKey, unratableStaleBefore)) {
          markTerminal(item.lastRatedAt)
          out.ignored++
          continue
        }

        // 'season' is unreachable today (type 3 is never polled, see above)
        // and is kept only so a season row, if one ever did arrive, is
        // classified honestly instead of falling through to the movie/episode
        // path -- where it has no grandparentRatingKey, would resolve to no
        // ids, and would pin this section's cursor as `unresolved` forever.
        if (item.type === 'show' || item.type === 'season') {
          // Terminal by design: bingers has no show/season rating concept.
          markTerminal(item.lastRatedAt)
          // Deliberately the NON-expiring question. The TTL above exists for
          // a catalogue that may gain an entry; no catalogue update will give
          // bingers a show-level rating, so re-reporting this every week
          // would be pure noise in `failures`.
          if (deps.store.isUnratable(item.ratingKey)) { out.ignored++; continue }
          if (dryRun) {
            console.log(`[DRY_RUN] would mark ${item.type} ${item.ratingKey} (${item.title ?? ''}) unratable`)
          } else {
            deps.store.markUnratable(item.ratingKey, `${item.type} ratings have no bingers equivalent`)
            deps.store.recordFailure('ratings', `${item.type} rating skipped: ${item.title}`, { ratingKey: item.ratingKey })
          }
          out.unsupported++
          continue
        }

        const rating = plexToBingers(item.userRating)
        if (rating == null) {
          // Terminal: the rating itself is out of range and cannot improve on retry.
          markTerminal(item.lastRatedAt)
          if (dryRun) console.log(`[DRY_RUN] ${item.type} ${item.ratingKey} rating ${item.userRating} out of range, ignoring`)
          out.ignored++
          continue
        }

        const kind = item.type === 'movie' ? 'movie' : 'show'
        const ids: ExternalIds = item.type === 'movie'
          ? parseGuids(item.guids)
          : await showIdsFor(item.grandparentRatingKey ?? '')
        if (Object.keys(ids).length === 0) {
          // Retryable: an empty Guid array is a server-side condition that can change.
          markRetryable(item.lastRatedAt)
          if (dryRun) console.log(`[DRY_RUN] ${item.type} ${item.ratingKey} (${item.title ?? ''}) has no external ids yet, will retry`)
          out.unresolved++
          continue
        }

        const t2 = await resolveTitle(rd, { title: item.title ?? '', kind, ids })
        if ('failure' in t2) {
          if (!t2.retryable) { markNoMatch(item, t2.failure); continue }
          // Retryable: network, catalog TTL, rate limit are all transient.
          markRetryable(item.lastRatedAt)
          if (dryRun) console.log(`[DRY_RUN] could not resolve title for ${item.type} ${item.ratingKey}: ${t2.failure}`)
          out.unresolved++
          continue
        }

        let entityKind: 'episode' | 'movie' = 'movie'
        let entityId = t2.titleId
        if (item.type === 'episode') {
          if (item.parentIndex == null || item.index == null) {
            // Terminal: a malformed item, not a transient condition.
            markTerminal(item.lastRatedAt)
            if (dryRun) console.log(`[DRY_RUN] episode ${item.ratingKey} missing season/episode number, ignoring`)
            out.ignored++
            continue
          }
          const e = await resolveEpisode({ ...rd, catalogTtlHours: deps.config.catalogTtlHours },
            { titleId: t2.titleId, season: item.parentIndex, number: item.index })
          if ('failure' in e) {
            if (!e.retryable) { markNoMatch(item, e.failure); continue }
            // Retryable, same reasoning as the title resolve above.
            markRetryable(item.lastRatedAt)
            if (dryRun) console.log(`[DRY_RUN] could not resolve S${item.parentIndex}E${item.index} of ${t2.titleId}: ${e.failure}`)
            out.unresolved++
            continue
          }
          entityKind = 'episode'; entityId = e.episodeId
        }

        const prev = deps.store.getRatingLink(entityKind, entityId)
        if (prev && prev.bingersRating === rating && prev.plexRating === item.userRating) {
          // Terminal: already mirrored, nothing left to do.
          markTerminal(item.lastRatedAt)
          if (dryRun) console.log(`[DRY_RUN] ${entityKind} ${entityId} already mirrored at rating ${rating}, nothing to do`)
          out.ignored++
          continue
        }

        if (dryRun) {
          // Read + log only: no push, no cursor, no rating_link, no failure row.
          console.log(`[DRY_RUN] would set bingers rating ${rating} on ${entityKind} ${entityId} (plex ${item.userRating})`)
          out.ignored++
          continue
        }

        const outcome = await submit(
          { auth: deps.auth, store: deps.store, userAgent: deps.config.bingersUserAgent,
            dryRun: deps.config.dryRun, watchDateToleranceSec: deps.config.watchDateToleranceSec,
            fetchImpl: deps.fetchImpl, notifyUrl: deps.config.notifyUrl },
          deps.gate,
          // ONLY the rating. The captured op is `fields: {rating: 5}` on its own --
          // adding watched/plays here would mark an item watched merely because it
          // was rated, which is a different user action entirely.
          [{ opId: newId(), table: 'entries', pk: { entityKind, entityId }, fields: { rating } }],
        )

        if (outcome === 'sent' || outcome === 'queued' || outcome === 'halted') {
          // 'queued' and 'halted' both durably enqueue the op (src/outbox.ts
          // enqueueOps on every path that returns either) -- flushOutbox will
          // eventually deliver it. Writing the link now fails safe: worst case
          // Task 5 declines to write back a rating bingers doesn't have yet.
          // Skipping it fails destructively -- Task 5 would see origin===null
          // and round-trip the rounded value back over the user's half-star.
          deps.store.putRatingLink({
            entityKind, entityId, bingersRating: rating,
            plexRating: item.userRating, plexRatingKey: item.ratingKey, origin: 'plex',
          })
          out.synced++
          if (outcome === 'halted') {
            // The session is dead: stop touching Plex/Bingers for the rest of
            // this run. This item and every later one in this section's window
            // stay UNDER the cursor (sectionBlocked), so a retry next run
            // re-resolves them -- the already-linked guard above makes that a
            // safe no-op for anything already written this run.
            sectionBlocked = true
            runHalted = true
            break
          }
          markTerminal(item.lastRatedAt)
          continue
        }

        // 'partial': with exactly one op per submit() call this branch is
        // unreachable in practice today (src/outbox.ts's
        // `applied.length > 0 ? 'partial' : 'queued'` means a single rejected
        // op always resolves to 'queued', never 'partial' -- see report).
        // Handled anyway, defensively, exactly as ruled: retryable, not terminal.
        out.failed++
        markRetryable(item.lastRatedAt)
      }
      if (runHalted) break
    }

    if (!dryRun) {
      const limit = blockedAt === null ? maxSeen : blockedAt - 1
      if (blockedAt !== null) {
        // A section with a retryable item pins the cursor below maxSeen --
        // potentially indefinitely, if that item never resolves (a guid-less
        // home video, say). One row per section per run (not per item, which
        // would flood the table on every poll) so a cursor stalled silently
        // for runs on end is visible on Task 7's /health instead of invisible.
        deps.store.recordFailure(
          'ratings', `section ${sec.key} rating cursor held at ${limit} by a retryable item`,
          { sectionKey: sec.key, since, blockedAt, limit },
        )
      }
      if (!sectionBlocked && limit > since) deps.store.setCursor(cursorKey, String(limit))
    }
    if (runHalted) break
  }

  return finish()
}
