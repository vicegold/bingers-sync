import type { Store, EpisodeMapping } from './store.js'
import { searchTitles, fetchMetadata, externalIdMap, fetchVersions, fetchSeason, type TitleMetadata } from './bingers/catalog.js'

export type ExternalIds = { tmdb?: string; tvdb?: string; imdb?: string }
export type ResolveDeps = { store: Store; fetchImpl?: typeof fetch; searchMaxPages: number }

/**
 * A resolution that did not produce a verified id.
 *
 * `retryable` distinguishes the two cases that must never be conflated:
 *  - absent: we checked and nothing matched -- a real, permanent no-match
 *  - true:   an upstream error stopped us checking, so we do NOT know whether
 *            a match exists. `details` carries enough to replay the lookup.
 */
export type ResolveFailure = { failure: string; retryable?: true; details?: unknown }

const SOURCES = ['tmdb', 'tvdb', 'imdb'] as const

function intersects(a: ExternalIds, b: Record<string, string>): boolean {
  return SOURCES.some(s => a[s] != null && b[s] != null && String(a[s]) === b[s])
}

function cacheAll(store: Store, meta: TitleMetadata, kind: string, titleId: string) {
  const ids = externalIdMap(meta)
  store.putTitleMapping(
    Object.entries(ids).map(([source, extId]) => ({
      source, extId, kind, titleId, title: meta.title ?? null, year: meta.year ?? null,
    })),
  )
}

export async function resolveTitle(
  deps: ResolveDeps,
  args: { title: string; kind: 'show' | 'movie'; ids: ExternalIds },
): Promise<{ titleId: string } | ResolveFailure> {
  const { store, searchMaxPages } = deps
  const fetchImpl = deps.fetchImpl ?? fetch
  // Candidates we could not rule in or out because their metadata fetch failed.
  const unchecked: { titleId: string; metadata: string; error: string }[] = []

  for (const s of SOURCES) {
    const v = args.ids[s]
    if (!v) continue
    const hit = store.getTitleId(s, String(v), args.kind)
    if (hit) return { titleId: hit }
  }

  if (!SOURCES.some(s => args.ids[s])) return { failure: 'no external ids supplied' }

  for (let page = 0; page < searchMaxPages; page++) {
    let results
    try {
      results = await searchTitles(args.title, page, fetchImpl)
    } catch (e) {
      return { failure: `search failed: ${(e as Error).message}` }
    }
    if (results.length === 0) break

    for (const r of results) {
      if (r.kind !== args.kind) continue
      let meta: TitleMetadata
      try {
        meta = await fetchMetadata(r.id, r.metadata, fetchImpl)
      } catch (e) {
        // NOT a no-match: a 5xx on the TRUE candidate is indistinguishable
        // here from a genuine miss, so record it and refuse to conclude.
        unchecked.push({ titleId: r.id, metadata: r.metadata, error: (e as Error).message })
        continue
      }
      if (intersects(args.ids, externalIdMap(meta))) {
        cacheAll(store, meta, args.kind, r.id)
        return { titleId: r.id }
      }
    }
  }

  if (unchecked.length) {
    // Deliberately not retried in a loop: an upstream having a bad minute
    // should not be hammered, and the replay payload lets this be redone by
    // hand or by a future failures replayer.
    return {
      failure: `resolution inconclusive: ${unchecked.length} candidate(s) for ${args.kind} `
        + `${JSON.stringify(args.ids)} could not be checked due to an upstream error `
        + `(${unchecked[0]!.error}) — this is NOT a confirmed no-match`,
      retryable: true,
      details: { title: args.title, kind: args.kind, ids: args.ids, unchecked },
    }
  }
  return { failure: `no external id match for ${args.kind} ${JSON.stringify(args.ids)}` }
}

export type EpisodeDeps = ResolveDeps & { catalogTtlHours: number }

export type HydrateResult = {
  failedSeasons: { season: number; hash: string; error: string }[]
  /** Seasons whose file was actually re-fetched this run. */
  fetchedSeasons: number[]
  /** Seasons skipped because their hash was identical to the stored one. */
  unchangedSeasons: number[]
}

function storedSeasonHashes(files: unknown): Record<string, string> {
  const seasons = (files as { seasons?: unknown } | null | undefined)?.seasons
  if (!seasons || typeof seasons !== 'object') return {}
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(seasons as Record<string, unknown>)) {
    if (typeof v === 'string') out[k] = v
  }
  return out
}

/**
 * Is a proactive re-check of versions.json due for this title?
 *
 * Only ever consulted when the episode ALREADY resolved from cache: a miss
 * forces the check unconditionally, because a newly aired episode cannot be
 * made to wait out a 24h TTL. No stored version at all counts as due -- the
 * age of the cache is then unknown, which is not the same as young.
 */
export function catalogRecheckDue(deps: EpisodeDeps, titleId: string, nowMs = Date.now()): boolean {
  const cur = deps.store.getCatalogVersion(titleId)
  if (!cur) return true
  const t = Date.parse(cur.fetchedAt)
  if (!Number.isFinite(t)) return true
  return nowMs - t >= Math.max(0, deps.catalogTtlHours) * 3_600_000
}

/**
 * Re-check versions.json and re-fetch only what actually moved.
 *
 * The stored versions.json is compared season by season against the fresh one;
 * a season whose hash is unchanged is NOT re-fetched. A first-ever hydrate has
 * nothing stored, so every season is new and all of them are fetched.
 *
 * What gets persisted is the map we can HONESTLY claim to hold: a season whose
 * fetch failed keeps its previously stored hash (or is dropped if it had none),
 * so the next hydrate still sees a difference and retries it. Persisting the
 * fresh hash for a season we failed to download would make the skip above turn
 * a transient 503 into a permanent hole in episode_map.
 */
export async function hydrateEpisodes(deps: EpisodeDeps, titleId: string): Promise<HydrateResult> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const failedSeasons: HydrateResult['failedSeasons'] = []
  const fetchedSeasons: number[] = []
  const unchangedSeasons: number[] = []

  const stored = deps.store.getCatalogVersion(titleId)
  const prev = storedSeasonHashes(stored?.files)
  const files = await fetchVersions(titleId, fetchImpl)
  const seasons = files.seasons ?? {}

  const effective: Record<string, string> = {}
  for (const [seasonStr, hash] of Object.entries(seasons)) {
    const season = Number(seasonStr)
    if (prev[seasonStr] === hash) {
      // Same hash means the same season file, byte for byte. Re-fetching it
      // would return exactly what episode_map already holds.
      unchangedSeasons.push(season)
      effective[seasonStr] = hash
      continue
    }
    let eps
    try {
      eps = await fetchSeason(titleId, season, hash, fetchImpl)
    } catch (e) {
      // One season failing must not become "that episode does not exist".
      failedSeasons.push({ season, hash, error: (e as Error).message })
      const before = prev[seasonStr]
      if (before !== undefined) effective[seasonStr] = before
      continue
    }
    fetchedSeasons.push(season)
    effective[seasonStr] = hash
    const rows: EpisodeMapping[] = eps.map(e => ({
      titleId, season, number: e.n, episodeId: e.id,
      abs: e.abs ?? null, title: e.title ?? null, aired: e.aired ?? null, seasonHash: hash,
    }))
    if (rows.length) deps.store.putEpisodes(rows)
  }

  deps.store.putCatalogVersion(titleId, { ...files, seasons: effective })
  return { failedSeasons, fetchedSeasons, unchangedSeasons }
}

export async function resolveEpisode(
  deps: EpisodeDeps,
  args: { titleId: string; season: number; number: number },
): Promise<{ episodeId: string } | ResolveFailure> {
  const hit = deps.store.getEpisodeId(args.titleId, args.season, args.number)
  if (hit) {
    // Cache hit: the answer is already in hand. The only reason to touch the
    // network is the TTL, and if that re-check fails the cached answer still
    // stands -- a proactive refresh must never turn a resolvable episode into
    // a failure.
    if (catalogRecheckDue(deps, args.titleId)) {
      try { await hydrateEpisodes(deps, args.titleId) } catch { /* cached answer stands */ }
      return { episodeId: deps.store.getEpisodeId(args.titleId, args.season, args.number) ?? hit }
    }
    return { episodeId: hit }
  }

  let hydrated: HydrateResult
  try {
    hydrated = await hydrateEpisodes(deps, args.titleId)
  } catch (e) {
    // versions.json itself failed: we never even learned what seasons exist.
    return {
      failure: `catalog hydrate failed: ${(e as Error).message}`,
      retryable: true,
      details: { titleId: args.titleId, season: args.season, number: args.number },
    }
  }

  const after = deps.store.getEpisodeId(args.titleId, args.season, args.number)
  if (after) return { episodeId: after }

  const failed = hydrated.failedSeasons.find(f => f.season === args.season)
  if (failed) {
    return {
      failure: `resolution inconclusive: season ${args.season} of title ${args.titleId} could not be `
        + `fetched (${failed.error}), so S${args.season}E${args.number} is unknown, not absent`,
      retryable: true,
      details: { titleId: args.titleId, season: args.season, number: args.number, failedSeasons: hydrated.failedSeasons },
    }
  }
  return { failure: `no episode S${args.season}E${args.number} for title ${args.titleId}` }
}
