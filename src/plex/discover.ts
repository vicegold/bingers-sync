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

/**
 * The ratingKeys already on the plex watchlist.
 *
 * This is what makes an add honest. addToWatchlist is idempotent -- it answers
 * 200 whether or not the title was already there -- so a successful call proves
 * nothing about who put it on the list. Without this check the service recorded
 * every such call as its own doing and would later "take back" titles the user
 * had watchlisted years earlier.
 *
 * Paginated deliberately: the listing defaults to 20 per page and a real
 * watchlist runs to hundreds, so a single page would report most of it as
 * absent -- the wrong answer, in the dangerous direction.
 */
export async function fetchWatchlistKeys(deps: DiscoverDeps): Promise<Set<string>> {
  const keys = new Set<string>()
  for (let start = 0; start < WATCHLIST_MAX; start += WATCHLIST_PAGE) {
    const res = await call(deps, `${D}/library/sections/watchlist/all`
      + `?X-Plex-Container-Start=${start}&X-Plex-Container-Size=${WATCHLIST_PAGE}`)
    const b = (await res.json()) as { MediaContainer?: { totalSize?: number; Metadata?: { ratingKey?: unknown }[] } }
    const page = b.MediaContainer?.Metadata ?? []
    for (const m of page) if (m.ratingKey != null) keys.add(String(m.ratingKey))
    // An empty page ends it even if totalSize disagrees: trusting the count
    // alone would spin here forever against a server that keeps saying 0.
    if (page.length === 0 || keys.size >= (b.MediaContainer?.totalSize ?? 0)) break
  }
  return keys
}

const WATCHLIST_PAGE = 100
const WATCHLIST_MAX = 10_000

export async function addToWatchlist(deps: DiscoverDeps, ratingKey: string): Promise<void> {
  await call(deps, `${D}/actions/addToWatchlist?ratingKey=${encodeURIComponent(ratingKey)}`, { method: 'PUT' })
}

// The exact mirror of the add, verified live against discover: 200 with
// {"MediaContainer":{"size":0}}. Non-2xx throws, so the caller backs off and
// keeps the link rather than forgetting a title still sitting on the watchlist.
export async function removeFromWatchlist(deps: DiscoverDeps, ratingKey: string): Promise<void> {
  await call(deps, `${D}/actions/removeFromWatchlist?ratingKey=${encodeURIComponent(ratingKey)}`, { method: 'PUT' })
}
