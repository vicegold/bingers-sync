import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import type { Store } from './store.js'
import type { Auth } from './bingers/auth.js'
import type { PlexScrobble, PulsarrEvent } from './routes/parse.js'
import { resolveTitle, resolveEpisode, type ExternalIds } from './resolve.js'
import { fetchShowIds, fetchAllLeaves, parseGuids } from './plex/client.js'
import { planScrobble, planWatchlist } from './plan.js'
import { pushOps, applyDates, type SyncDeps } from './bingers/sync.js'
import { notify } from './notify.js'

export type AppDeps = {
  config: Config; store: Store; auth: Auth
  fetchImpl?: typeof fetch; newId?: () => string
}
export type HandlerResult = { status: 'ok' | 'ignored' | 'failed'; reason?: string }

const iso = (unixSeconds: number | null) =>
  new Date((unixSeconds ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()

function syncDeps(d: AppDeps): SyncDeps {
  return {
    auth: d.auth, store: d.store, userAgent: d.config.bingersUserAgent,
    dryRun: d.config.dryRun, watchDateToleranceSec: d.config.watchDateToleranceSec,
    fetchImpl: d.fetchImpl,
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
  if ('failure' in t) return fail(d, 'plex', t.failure, s)

  let entityId = t.titleId
  if (s.type === 'episode') {
    if (s.season == null || s.number == null) return fail(d, 'plex', 'episode scrobble without season/number', s)
    const e = await resolveEpisode({ ...rd, catalogTtlHours: d.config.catalogTtlHours },
      { titleId: t.titleId, season: s.season, number: s.number })
    if ('failure' in e) return fail(d, 'plex', e.failure, s)
    entityId = e.episodeId
  }

  const backfill: { episodeId: string; plays: number; watchedAt: string }[] = []
  if (s.type === 'episode') {
    try {
      const leaves = await fetchAllLeaves(pd, s.showRatingKey!)
      for (const l of leaves) {
        if (l.viewCount < 1) continue
        const epId = d.store.getEpisodeId(t.titleId, l.season, l.number)
        if (!epId || epId === entityId) continue
        if (alreadyWatched(d.store, 'episode', epId)) continue
        backfill.push({ episodeId: epId, plays: l.viewCount, watchedAt: iso(l.lastViewedAt) })
      }
    } catch { /* backfill is best-effort; the scrobble itself still lands */ }
  }

  const plan = planScrobble({
    titleId: t.titleId, kind, entityKind: s.type, entityId,
    plays: Math.max(1, s.viewCount), watchedAt: iso(s.lastViewedAt),
    isFollowed: isFollowed(d.store, t.titleId), backfill, newId,
  })

  await pushOps(syncDeps(d), plan.ops)
  await applyDates(syncDeps(d), plan.dated)
  return { status: 'ok' }
}

export async function handlePulsarr(d: AppDeps, e: PulsarrEvent): Promise<HandlerResult> {
  if (e.user !== d.config.allowedUser) return { status: 'ignored' }
  const newId = d.newId ?? randomUUID
  const rd = { store: d.store, fetchImpl: d.fetchImpl, searchMaxPages: d.config.searchMaxPages }

  const t = await resolveTitle(rd, { title: e.title, kind: e.kind, ids: parseGuids(e.guids) })
  if ('failure' in t) return fail(d, 'pulsarr', t.failure, e)

  const plan = planWatchlist({ titleId: t.titleId, kind: e.kind, action: e.action, newId })
  await pushOps(syncDeps(d), plan.ops)
  return { status: 'ok' }
}
