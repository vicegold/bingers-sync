import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import type { Store } from './store.js'
import type { Auth } from './bingers/auth.js'
import type { PlexScrobble, PulsarrEvent } from './routes/parse.js'
import { resolveTitle, resolveEpisode, type ExternalIds, type ResolveFailure } from './resolve.js'
import { fetchShowIds, fetchAllLeaves, parseGuids } from './plex/client.js'
import { planScrobble, planWatchlist } from './plan.js'
import { type SyncDeps } from './bingers/sync.js'
import { submit, type Gate } from './outbox.js'
import { notify } from './notify.js'

export type AppDeps = {
  config: Config; store: Store; auth: Auth; gate: Gate
  fetchImpl?: typeof fetch; newId?: () => string
}
export type HandlerResult = { status: 'ok' | 'ignored' | 'failed'; reason?: string }

const iso = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString()

// The scrobbled item itself may legitimately fall back to "now": the event
// fired because it was just watched. A BACKFILL leaf may not -- see
// backfillWatchedAt.
const scrobbleWatchedAt = (unixSeconds: number | null) =>
  unixSeconds != null && Number.isFinite(unixSeconds) ? iso(unixSeconds) : new Date().toISOString()

// plays must be a positive integer on the wire. Plex can hand us a
// non-numeric viewCount, and Math.max(1, NaN) is NaN, which serialises as
// null and is not caught by any `< 1` test.
const scrobblePlays = (viewCount: number) =>
  Number.isFinite(viewCount) ? Math.max(1, Math.trunc(viewCount)) : 1

export type MirrorFreshness = { syncedAt: string | null; fresh: boolean; maxAgeMin: number }

/**
 * Is sync_state recent enough to be read as "Bingers does not have this"?
 * A mirror that has never synced, or whose last successful pull is older than
 * roughly two pull intervals, cannot support that inference: absence in the
 * mirror then means "we do not know", not "not watched".
 */
export function mirrorFreshness(store: Store, syncPullIntervalMin: number): MirrorFreshness {
  const maxAgeMin = Math.max(1, syncPullIntervalMin) * 2
  const syncedAt = store.getMirrorSyncedAt()
  if (!syncedAt) return { syncedAt: null, fresh: false, maxAgeMin }
  const t = Date.parse(syncedAt)
  if (!Number.isFinite(t)) return { syncedAt, fresh: false, maxAgeMin }
  return { syncedAt, fresh: Date.now() - t <= maxAgeMin * 60_000, maxAgeMin }
}

function syncDeps(d: AppDeps): SyncDeps {
  return {
    auth: d.auth, store: d.store, userAgent: d.config.bingersUserAgent,
    dryRun: d.config.dryRun, watchDateToleranceSec: d.config.watchDateToleranceSec,
    fetchImpl: d.fetchImpl, notifyUrl: d.config.notifyUrl,
  }
}

function isFollowed(store: Store, titleId: string): boolean {
  const row = store.getSyncRow('follows', titleId)
  // A row with deletedAt set counts as NOT followed: a scrobble re-follows a
  // title you removed, matching the app's own "add to your list?" prompt.
  return !!row && !row.deletedAt
}

function alreadyWatched(store: Store, entityKind: string, entityId: string): boolean {
  const row = store.getSyncRow('entries', `${entityKind}:${entityId}`)
  return !!row && row.watched === true && !row.deletedAt
}

async function fail(d: AppDeps, source: string, reason: string, payload: unknown): Promise<HandlerResult> {
  d.store.recordFailure(source, reason, payload)
  await notify(d.config.notifyUrl, `${source}: ${reason}`)
  return { status: 'failed', reason }
}

// A resolve failure that could not rule a candidate in OR out carries the
// unchecked candidates; record them with the event so the lookup is replayable
// by hand rather than being filed as a confident no-match.
function failResolve(d: AppDeps, source: string, r: ResolveFailure, event: unknown): Promise<HandlerResult> {
  const payload = r.retryable ? { retryable: true, event, resolve: r.details ?? null } : event
  return fail(d, source, r.failure, payload)
}

export async function handlePlex(d: AppDeps, s: PlexScrobble): Promise<HandlerResult> {
  if (s.user !== d.config.allowedUser) return { status: 'ignored' }
  const newId = d.newId ?? randomUUID
  const rd = { store: d.store, fetchImpl: d.fetchImpl, searchMaxPages: d.config.searchMaxPages }
  const pd = { plexUrl: d.config.plexUrl, plexToken: d.config.plexToken, fetchImpl: d.fetchImpl }

  let ids: ExternalIds
  let searchTitle: string
  const kind = s.type === 'movie' ? 'movie' : 'show'

  if (s.type === 'movie') {
    ids = parseGuids(s.guids)
    searchTitle = s.title
  } else {
    if (!s.showRatingKey) return fail(d, 'plex', 'episode scrobble without grandparentRatingKey', s)
    try {
      ids = await fetchShowIds(pd, s.showRatingKey)
    } catch (e) {
      return fail(d, 'plex', `plex show lookup failed: ${(e as Error).message}`, s)
    }
    searchTitle = s.grandparentTitle ?? s.title
  }

  const t = await resolveTitle(rd, { title: searchTitle, kind, ids })
  if ('failure' in t) return failResolve(d, 'plex', t, s)

  let entityId = t.titleId
  if (s.type === 'episode') {
    if (s.season == null || s.number == null) return fail(d, 'plex', 'episode scrobble without season/number', s)
    const e = await resolveEpisode({ ...rd, catalogTtlHours: d.config.catalogTtlHours },
      { titleId: t.titleId, season: s.season, number: s.number })
    if ('failure' in e) return failResolve(d, 'plex', e, s)
    entityId = e.episodeId
  }

  const backfill: { episodeId: string; plays: number; watchedAt: string }[] = []
  if (s.type === 'episode') {
    const mirror = mirrorFreshness(d.store, d.config.syncPullIntervalMin)
    if (!mirror.fresh) {
      // Backfill infers "Bingers has not seen this episode" from the ABSENCE of
      // a sync_state row. On a cold or stale mirror that inference is simply
      // wrong, and acting on it rewrites the date of every pre-existing watch
      // record for the show -- irreversibly, and with every request returning
      // 200 so nothing looks broken. Skip the inferred bulk write; the
      // scrobbled episode below still lands.
      d.store.recordFailure('plex', 'backfill skipped: local mirror is not fresh'
        + ` (${mirror.syncedAt ? `last sync/pull succeeded ${mirror.syncedAt}` : 'sync/pull has never succeeded'},`
        + ` max age ${mirror.maxAgeMin}m) — the already-watched filter cannot be trusted`, s)
    } else {
      try {
        const leaves = await fetchAllLeaves(pd, s.showRatingKey!)
        for (const l of leaves) {
          if (!Number.isFinite(l.viewCount) || l.viewCount < 1) continue
          // No real Plex timestamp means no genuine date to write. The spec's
          // "there is no invented date" holds by excluding the leaf, not by
          // stamping it with now.
          if (l.lastViewedAt == null || !Number.isFinite(l.lastViewedAt)) continue
          const epId = d.store.getEpisodeId(t.titleId, l.season, l.number)
          if (!epId || epId === entityId) continue
          if (alreadyWatched(d.store, 'episode', epId)) continue
          backfill.push({ episodeId: epId, plays: Math.max(1, Math.trunc(l.viewCount)), watchedAt: iso(l.lastViewedAt) })
        }
      } catch { /* backfill is best-effort; the scrobble itself still lands */ }
    }
  }

  const plan = planScrobble({
    titleId: t.titleId, kind, entityKind: s.type, entityId,
    plays: scrobblePlays(s.viewCount), watchedAt: scrobbleWatchedAt(s.lastViewedAt),
    isFollowed: isFollowed(d.store, t.titleId), backfill, newId,
  })

  // submit owns the whole write: it re-queues anything the server did not
  // confirm, corrects the dates of what landed (including after a later
  // flush), and halts the gate on 401 from either half.
  await submit(syncDeps(d), d.gate, plan.ops, plan.dated)
  return { status: 'ok' }
}

export async function handlePulsarr(d: AppDeps, e: PulsarrEvent): Promise<HandlerResult> {
  if (e.user !== d.config.allowedUser) return { status: 'ignored' }
  const newId = d.newId ?? randomUUID
  const rd = { store: d.store, fetchImpl: d.fetchImpl, searchMaxPages: d.config.searchMaxPages }

  const t = await resolveTitle(rd, { title: e.title, kind: e.kind, ids: parseGuids(e.guids) })
  if ('failure' in t) return failResolve(d, 'pulsarr', t, e)

  const plan = planWatchlist({ titleId: t.titleId, kind: e.kind, action: e.action, newId })
  await submit(syncDeps(d), d.gate, plan.ops, plan.dated)
  return { status: 'ok' }
}
