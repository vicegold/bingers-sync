import type { ExternalIds } from '../resolve.js'

const D = 'https://discover.provider.plex.tv'
const SCHEMES = new Set(['tmdb', 'tvdb', 'imdb'])

export type DiscoverDeps = { plexToken: string; fetchImpl?: typeof fetch; timeoutMs?: number }
export type DiscoverCandidate = { ratingKey: string; title: string | null; year: number | null }

export function ratingKeyFromGuid(guid: string): string {
  const parts = guid.split('/')
  return parts[parts.length - 1] ?? guid
}

function headers(deps: DiscoverDeps): Record<string, string> {
  return {
    'X-Plex-Token': deps.plexToken,
    Accept: 'application/json',
    'X-Plex-Product': 'bingers-sync',
    'X-Plex-Client-Identifier': 'bingers-sync',
  }
}

// Every discover call is a third-party request made inside a reconcile loop, so
// it needs a deadline of its own. Without one, undici's 300s header timeout
// applies, and a single hung request stalls the whole batch (and, at boot, the
// reconcile the rest of the service waits on) for minutes at a time.
export const DISCOVER_TIMEOUT_MS = 15_000

async function call(deps: DiscoverDeps, url: string, init?: RequestInit): Promise<Response> {
  const res = await (deps.fetchImpl ?? fetch)(url, {
    ...init, headers: headers(deps), signal: AbortSignal.timeout(deps.timeoutMs ?? DISCOVER_TIMEOUT_MS),
  })
  if (!res.ok) throw new Error(`plex discover ${url} -> ${res.status}`)
  return res
}

export async function searchDiscover(
  deps: DiscoverDeps, query: string, kind: 'show' | 'movie',
): Promise<DiscoverCandidate[]> {
  const params = new URLSearchParams({
    query, limit: '5',
    searchTypes: kind === 'movie' ? 'movies' : 'tv',
    // Required. Omitting it makes the real API answer 400.
    searchProviders: 'discover',
    includeMetadata: '1',
  })
  const url = `${D}/library/search?${params}`.replace(/\+/g, '%20')
  const res = await call(deps, url)
  const body = (await res.json()) as any
  const groups = body?.MediaContainer?.SearchResults ?? []
  const out: DiscoverCandidate[] = []
  for (const g of groups) {
    for (const r of g?.SearchResult ?? []) {
      const m = r?.Metadata
      if (!m?.guid) continue
      out.push({ ratingKey: ratingKeyFromGuid(m.guid), title: m.title ?? null, year: m.year ?? null })
    }
  }
  return out
}

export async function discoverIds(deps: DiscoverDeps, ratingKey: string): Promise<ExternalIds> {
  const res = await call(deps, `${D}/library/metadata/${encodeURIComponent(ratingKey)}?includeGuids=1`)
  const body = (await res.json()) as any
  const out: ExternalIds = {}
  for (const g of body?.MediaContainer?.Metadata?.[0]?.Guid ?? []) {
    const m = /^([a-z]+):\/\/(.+)$/.exec(g?.id ?? '')
    if (!m) continue
    const [, scheme, id] = m
    if (scheme && id && SCHEMES.has(scheme) && !(scheme in out)) (out as any)[scheme] = id
  }
  return out
}

export async function addToWatchlist(deps: DiscoverDeps, ratingKey: string): Promise<void> {
  await call(deps, `${D}/actions/addToWatchlist?ratingKey=${encodeURIComponent(ratingKey)}`, { method: 'PUT' })
}
