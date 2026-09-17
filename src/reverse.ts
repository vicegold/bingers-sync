import type { Config } from './config.js'
import type { Store } from './store.js'
import { titleExternalIds } from './resolve.js'
import { searchDiscover, discoverIds, addToWatchlist, type DiscoverCandidate } from './plex/discover.js'
import { notify } from './notify.js'

export type ReverseDeps = { config: Config; store: Store; fetchImpl?: typeof fetch }

const SOURCES = ['tmdb', 'tvdb', 'imdb'] as const

export function reverseBackoffMs(attempts: number): number {
  return Math.min(3_600_000 * 2 ** attempts, 7 * 24 * 60 * 60_000)
}

// Deferrals get their own, much shorter curve. A deferral means "we could not
// tell", usually for a transient reason (catalogue hiccup, discover 5xx, an
// expired PLEX_TOKEN that will be swapped in minutes), so parking the title for
// an hour-to-a-week like a confirmed miss would be wrong. It still has to grow:
// a permanently-deferring title with no backoff at all keeps its batch slot on
// every single run -- its sync_state.updated_at never moves, and
// dueUnlinkedTitles is ORDER BY updated_at LIMIT n -- so healthy titles behind
// it are never reached and every cycle files another failure row.
export function reverseDeferBackoffMs(attempts: number): number {
  return Math.min(5 * 60_000 * 2 ** attempts, 30 * 60_000)
}

function intersects(a: Record<string, string | undefined>, b: Record<string, string | undefined>): boolean {
  return SOURCES.some(s => a[s] != null && b[s] != null && String(a[s]) === String(b[s]))
}

export async function reconcileWatchlist(
  deps: ReverseDeps,
): Promise<{ added: number; unresolved: number; skipped: number; deferred: number }> {
  const out = { added: 0, unresolved: 0, skipped: 0, deferred: 0 }
  if (!deps.config.reverseSync) return out

  const due = deps.store.dueUnlinkedTitles(new Date().toISOString(), deps.config.reverseBatch)
  const dd = { plexToken: deps.config.plexToken, fetchImpl: deps.fetchImpl }
  const rd = { store: deps.store, fetchImpl: deps.fetchImpl, searchMaxPages: deps.config.searchMaxPages }

  for (const titleId of due) {
    const row = deps.store.getSyncRow('follows', titleId)
    const kind = row?.kind === 'movie' ? 'movie' : 'show'

    const t = await titleExternalIds(rd, titleId, kind)

    // DRY_RUN is checked BEFORE any discover traffic AND before any of the
    // bookkeeping below, so a dry run leaves the title exactly as eligible as
    // it found it. Every remaining branch either talks to discover or writes
    // durable state (a plex_link row with a backoff, a failures row) and posts
    // to NOTIFY_URL -- none of which a dry run is allowed to do. The one thing
    // above this line, titleExternalIds, is a read whose only write is the
    // title_map cache it would have filled on any run.
    if (deps.config.dryRun) {
      if ('failure' in t) console.log(`[DRY_RUN] would defer ${titleId}: ${t.failure}`)
      else console.log(`[DRY_RUN] would add to plex watchlist: ${t.title} (${t.year}) ids=${JSON.stringify(t.ids)}`)
      out.skipped++; continue
    }

    if ('failure' in t) {
      // Catalogue lookup failed -- we never even got external ids to check
      // against. This is NOT a confirmed no-match, so it goes on the short
      // deferral curve rather than burning a real backoff attempt.
      await defer(deps, titleId, t.failure)
      out.deferred++; continue
    }
    // Two different causes, two different messages: a title with perfectly good
    // ids but no name cannot be SEARCHED for, which is not the same problem as
    // a named title with no ids to verify a match against.
    if (!t.title) {
      await fail(deps, titleId, `no searchable title for ${titleId}, cannot query discover`)
      out.unresolved++; continue
    }
    if (Object.keys(t.ids).length === 0) {
      await fail(deps, titleId, `no external ids for ${titleId}, cannot verify a discover match`)
      out.unresolved++; continue
    }

    let candidates: DiscoverCandidate[]
    try {
      candidates = await searchDiscover(dd, t.title, kind)
    } catch (e) {
      await defer(deps, titleId, `discover search failed for ${t.title}: ${(e as Error).message}`)
      out.deferred++; continue
    }

    // Each candidate is checked independently: a 404/429/5xx on one candidate
    // must not stop us examining the rest, or the true match further down the
    // list would never be reached. "No match" may only be concluded once
    // every candidate was actually checked -- if any errored and none of the
    // checked ones intersected, the outcome is unknown, not a confirmed miss.
    let ratingKey: string | null = null
    let hadCandidateError = false
    for (const cand of candidates) {
      try {
        const ids = await discoverIds(dd, cand.ratingKey)
        if (intersects(t.ids, ids)) { ratingKey = cand.ratingKey; break }
      } catch (e) {
        hadCandidateError = true
        console.warn(`[reverse] discover id lookup failed for candidate ${cand.ratingKey} of ${t.title}: ${(e as Error).message}`)
      }
    }

    if (!ratingKey && hadCandidateError) {
      await defer(deps, titleId, `could not verify all discover candidates for ${t.title} (${t.year}); some id lookups failed`)
      out.deferred++; continue
    }

    if (!ratingKey) {
      await fail(deps, titleId, `no verified discover match for ${t.title} (${t.year}) ids=${JSON.stringify(t.ids)}`)
      out.unresolved++; continue
    }

    try {
      await addToWatchlist(dd, ratingKey)
    } catch (e) {
      await fail(deps, titleId, `addToWatchlist failed for ${t.title}: ${(e as Error).message}`)
      out.unresolved++; continue
    }

    // The watchlist write already happened. If recording the link locally now
    // fails, the title must not be treated as unresolved (that would re-add
    // it, not recover it) and the rest of the batch must not be aborted --
    // log the orphan and move on; a later run's addToWatchlist is idempotent.
    try {
      deps.store.putPlexLink({ titleId, ratingKey, state: 'added', attempts: 0, nextTryAt: null })
    } catch (e) {
      console.error(`[reverse] added ${t.title} to plex watchlist but failed to record the local link (orphan): ${(e as Error).message}`)
    }
    console.log(`[reverse] added to plex watchlist: ${t.title} (${t.year}) -> ${ratingKey}`)
    out.added++
  }
  return out
}

async function fail(deps: ReverseDeps, titleId: string, reason: string) {
  const prev = deps.store.getPlexLink(titleId)
  // A prior DEFERRAL's attempts belong to the deferral curve, not this one --
  // carrying them over would start a first confirmed miss deep into the
  // exponential and could park it a week out on attempt one.
  const attempts = (prev?.state === 'unresolved' ? prev.attempts : 0) + 1
  deps.store.putPlexLink({
    titleId, ratingKey: null, state: 'unresolved', attempts,
    nextTryAt: new Date(Date.now() + reverseBackoffMs(attempts - 1)).toISOString(),
  })
  deps.store.recordFailure('reverse', reason, { titleId })
  await notify(deps.config.notifyUrl, `reverse sync: ${reason}`, deps.fetchImpl)
}

// A retryable, inconclusive outcome: this cycle could not fully verify the
// title (catalogue outage, a discover candidate errored, a bad PLEX_TOKEN).
// Nothing was ruled out, so this keeps its own bounded retry on the SHORT
// deferral curve -- separate from `unresolved`, which means a confirmed miss.
//
// The bound is the point. A title that defers forever used to write no
// plex_link at all, which made it eligible again on the very next run: with
// REVERSE_BATCH=n, n such titles hold every slot in the batch permanently and
// nothing behind them is ever reached. A bad PLEX_TOKEN defers EVERY title, so
// that path also filed a failure row and fired a notification per title per
// cycle, forever. Hence: a growing (if short) nextTryAt, and a notification
// only on the FIRST deferral of a title, not on every repeat.
async function defer(deps: ReverseDeps, titleId: string, reason: string) {
  const prev = deps.store.getPlexLink(titleId)
  const repeat = prev?.state === 'deferred'
  const attempts = (repeat ? prev.attempts : 0) + 1
  deps.store.putPlexLink({
    titleId, ratingKey: null, state: 'deferred', attempts,
    nextTryAt: new Date(Date.now() + reverseDeferBackoffMs(attempts - 1)).toISOString(),
  })
  deps.store.recordFailure('reverse', reason, { titleId })
  if (!repeat) await notify(deps.config.notifyUrl, `reverse sync: ${reason}`, deps.fetchImpl)
}
