const API = 'https://api.bingers.app'
const CATALOG = 'https://catalog.bingers.app'
const MATCHED_SOURCES = new Set(['tmdb', 'tvdb', 'imdb'])

export type SearchResult = {
  id: string; kind: 'show' | 'movie'; metadata: string
  card: { originalTitle: string; titlesI18n: Record<string, string>; year: number | null }
}
export type CatalogFiles = { metadata: string; seasons?: Record<string, string>; [k: string]: unknown }
export type TitleMetadata = { id: string; title: string; year: number | null; kind: string; external_ids: { id: string; source: string }[] }
export type CatalogEpisode = { n: number; abs: number | null; id: string; title: string | null; aired: string | null }

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return (await res.json()) as T
}

export async function searchTitles(q: string, page = 0, fetchImpl: typeof fetch = fetch): Promise<SearchResult[]> {
  const url = `${API}/search/titles?q=${encodeURIComponent(q)}&page=${page}&lang=de`
  const body = await getJson<{ results: SearchResult[] }>(url, fetchImpl)
  return body.results ?? []
}

export function fetchVersions(titleId: string, fetchImpl: typeof fetch = fetch): Promise<CatalogFiles> {
  return getJson<{ files: CatalogFiles }>(`${CATALOG}/catalog/${titleId}/versions.json`, fetchImpl)
    .then(b => b.files)
}

export function fetchMetadata(titleId: string, hash: string, fetchImpl: typeof fetch = fetch): Promise<TitleMetadata> {
  return getJson<TitleMetadata>(`${CATALOG}/catalog/${titleId}/metadata@${hash}.json`, fetchImpl)
}

export async function fetchSeason(titleId: string, season: number, hash: string, fetchImpl: typeof fetch = fetch): Promise<CatalogEpisode[]> {
  const b = await getJson<{ episodes: CatalogEpisode[] }>(`${CATALOG}/catalog/${titleId}/season-${season}@${hash}.json`, fetchImpl)
  return b.episodes ?? []
}

export function externalIdMap(m: TitleMetadata): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of m.external_ids ?? []) {
    if (MATCHED_SOURCES.has(e.source) && !(e.source in out)) out[e.source] = String(e.id)
  }
  return out
}
