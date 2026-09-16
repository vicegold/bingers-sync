import type { ExternalIds } from '../resolve.js'

export type PlexDeps = { plexUrl: string; plexToken: string; fetchImpl?: typeof fetch }
export type PlexEpisode = { season: number; number: number; viewCount: number; lastViewedAt: number | null; title: string | null }

const SCHEMES = new Set(['tmdb', 'tvdb', 'imdb'])

export function parseGuids(guids: { id: string }[] | undefined): ExternalIds {
  const out: ExternalIds = {}
  for (const g of guids ?? []) {
    const m = /^([a-z]+):\/\/(.+)$/.exec(g.id ?? '')
    if (!m) continue
    const [, scheme, id] = m
    if (scheme && id && SCHEMES.has(scheme) && !(scheme in out)) (out as any)[scheme] = id
  }
  return out
}

async function plexGet<T>(deps: PlexDeps, path: string): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(`${deps.plexUrl}${path}`, {
    headers: { 'X-Plex-Token': deps.plexToken, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`plex GET ${path} -> ${res.status}`)
  return (await res.json()) as T
}

export async function fetchShowIds(deps: PlexDeps, ratingKey: string): Promise<ExternalIds> {
  const b = await plexGet<{ MediaContainer?: { Metadata?: { Guid?: { id: string }[] }[] } }>(
    deps, `/library/metadata/${ratingKey}?includeGuids=1`)
  return parseGuids(b.MediaContainer?.Metadata?.[0]?.Guid)
}

export async function fetchAllLeaves(deps: PlexDeps, ratingKey: string): Promise<PlexEpisode[]> {
  const b = await plexGet<{ MediaContainer?: { Metadata?: any[] } }>(deps, `/library/metadata/${ratingKey}/allLeaves`)
  const out: PlexEpisode[] = []
  for (const m of b.MediaContainer?.Metadata ?? []) {
    const season = Number(m.parentIndex)
    const number = Number(m.index)
    // A leaf without a usable season/episode number cannot be matched to
    // anything downstream -- carrying it as NaN would poison every lookup
    // keyed on it, so it is excluded rather than passed through.
    if (!Number.isFinite(season) || !Number.isFinite(number)) continue
    out.push({
      season,
      number,
      viewCount: Number(m.viewCount ?? 0),
      lastViewedAt: m.lastViewedAt != null ? Number(m.lastViewedAt) : null,
      title: m.title ?? null,
    })
  }
  return out
}
