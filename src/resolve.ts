import type { Store, EpisodeMapping } from './store.js'
import { searchTitles, fetchMetadata, externalIdMap, fetchVersions, fetchSeason, type TitleMetadata } from './bingers/catalog.js'

export type ExternalIds = { tmdb?: string; tvdb?: string; imdb?: string }
export type ResolveDeps = { store: Store; fetchImpl?: typeof fetch; searchMaxPages: number }

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
): Promise<{ titleId: string } | { failure: string }> {
  const { store, searchMaxPages } = deps
  const fetchImpl = deps.fetchImpl ?? fetch

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
      } catch { continue }
      if (intersects(args.ids, externalIdMap(meta))) {
        cacheAll(store, meta, args.kind, r.id)
        return { titleId: r.id }
      }
    }
  }
  return { failure: `no external id match for ${args.kind} ${JSON.stringify(args.ids)}` }
}

export type EpisodeDeps = ResolveDeps & { catalogTtlHours: number }

export async function hydrateEpisodes(deps: EpisodeDeps, titleId: string): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const files = await fetchVersions(titleId, fetchImpl)
  deps.store.putCatalogVersion(titleId, files)
  const seasons = files.seasons ?? {}
  for (const [seasonStr, hash] of Object.entries(seasons)) {
    const season = Number(seasonStr)
    let eps
    try {
      eps = await fetchSeason(titleId, season, hash, fetchImpl)
    } catch { continue }
    const rows: EpisodeMapping[] = eps.map(e => ({
      titleId, season, number: e.n, episodeId: e.id,
      abs: e.abs ?? null, title: e.title ?? null, aired: e.aired ?? null, seasonHash: hash,
    }))
    if (rows.length) deps.store.putEpisodes(rows)
  }
}

export async function resolveEpisode(
  deps: EpisodeDeps,
  args: { titleId: string; season: number; number: number },
): Promise<{ episodeId: string } | { failure: string }> {
  const hit = deps.store.getEpisodeId(args.titleId, args.season, args.number)
  if (hit) return { episodeId: hit }

  try {
    await hydrateEpisodes(deps, args.titleId)
  } catch (e) {
    return { failure: `catalog hydrate failed: ${(e as Error).message}` }
  }

  const after = deps.store.getEpisodeId(args.titleId, args.season, args.number)
  if (after) return { episodeId: after }
  return { failure: `no episode S${args.season}E${args.number} for title ${args.titleId}` }
}
