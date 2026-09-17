import type { ExternalIds } from '../resolve.js'

export type PlexDeps = { plexUrl: string; plexToken: string; fetchImpl?: typeof fetch }
export type PlexEpisode = {
  season: number; number: number; viewCount: number; lastViewedAt: number | null
  title: string | null; ratingKey: string; userRating: number | null
}

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
    // Same rule for ratingKey: a leaf with none would otherwise stringify to
    // the literal "undefined" via String(undefined) and flow straight into a
    // real `PUT /:/rate?key=undefined` downstream. Excluded, not passed on.
    if (m.ratingKey == null) continue
    out.push({
      season,
      number,
      viewCount: Number(m.viewCount ?? 0),
      lastViewedAt: m.lastViewedAt != null ? Number(m.lastViewedAt) : null,
      title: m.title ?? null,
      ratingKey: String(m.ratingKey),
      // Verified live against the real server on the section-listing endpoint:
      // a RATED item carries userRating (e.g. 9.0), an unrated one OMITS the
      // key entirely rather than sending null. Check for null/undefined BEFORE
      // coercing -- Number(null) is 0, which is finite and would read as "rated 0".
      userRating: m.userRating != null ? Number(m.userRating) : null,
    })
  }
  return out
}

export type PlexSection = { key: string; type: 'movie' | 'show' | 'artist'; title: string }
export type PlexRatedItem = {
  ratingKey: string; type: 'movie' | 'show' | 'season' | 'episode'
  title: string | null; userRating: number; lastRatedAt: number
  guids: { id: string }[]; grandparentRatingKey: string | null
  parentIndex: number | null; index: number | null
}

export async function fetchSections(deps: PlexDeps): Promise<PlexSection[]> {
  const b = await plexGet<{ MediaContainer?: { Directory?: any[] } }>(deps, '/library/sections')
  return (b.MediaContainer?.Directory ?? []).map(d => ({
    key: String(d.key), type: d.type, title: d.title ?? '',
  }))
}

export async function fetchRatedSince(
  deps: PlexDeps, sectionKey: string, plexType: 1 | 2 | 4, sinceUnix: number,
): Promise<PlexRatedItem[]> {
  // `lastRatedAt>>=` is plex's "greater than" filter operator; the value is unix seconds.
  // includeGuids=1 is mandatory: without it the server omits `Guid` entirely
  // (confirmed live on both movie and episode metadata), so parseGuids(item.guids)
  // -- the only source of external ids for a movie rating -- would always yield {}.
  const qs = new URLSearchParams({ type: String(plexType), sort: 'lastRatedAt:desc', includeGuids: '1' })
  qs.set('lastRatedAt>>', String(sinceUnix))
  // Deliberately unpaged: confirmed live that omitting X-Plex-Container-* headers
  // returns the complete result set (460 of 460, no `totalSize` truncation),
  // while setting an explicit container size without a paging loop truncates
  // silently. Do not add a container size here without also adding the loop.
  const b = await plexGet<{ MediaContainer?: { Metadata?: any[] } }>(
    deps, `/library/sections/${sectionKey}/all?${qs}`)
  const out: PlexRatedItem[] = []
  for (const m of b.MediaContainer?.Metadata ?? []) {
    const ur = Number(m.userRating)
    if (!Number.isFinite(ur)) continue
    out.push({
      ratingKey: String(m.ratingKey), type: m.type, title: m.title ?? null,
      userRating: ur, lastRatedAt: Number(m.lastRatedAt ?? 0),
      guids: Array.isArray(m.Guid) ? m.Guid : [],
      grandparentRatingKey: m.grandparentRatingKey != null ? String(m.grandparentRatingKey) : null,
      parentIndex: m.parentIndex != null ? Number(m.parentIndex) : null,
      index: m.index != null ? Number(m.index) : null,
    })
  }
  return out
}

// One section-scan entry: the item's ratingKey plus its CURRENT live rating
// (null if Plex reports none). Carrying userRating here -- rather than only
// ratingKey -- lets a caller compare against what Plex actually holds right
// now instead of trusting its own possibly-absent, possibly-stale bookkeeping.
export type SectionIndexEntry = { ratingKey: string; userRating: number | null }

/**
 * Every item in a section with its guids, paged. Deliberately does NOT filter on
 * lastRatedAt: an UNRATED item is exactly what the bingers->plex direction needs
 * to find, and `lastRatedAt>>=0` returns only already-rated rows (verified live:
 * 2 of 2 returned were rated, while the unfiltered call returned 200).
 *
 * The bingers->plex half-star guard (src/ratings/toPlex.ts Layer 2) depends on
 * this unfiltered listing actually carrying `userRating` -- verified live:
 * `GET /library/sections/2/all?type=1&includeGuids=1` (container 0..200) returned
 * "Harry Potter and the Sorcerer's Stone" with `userRating=9.0`, `ratingKey=7727`,
 * and guids intact; unrated items OMIT the `userRating` key entirely rather than
 * sending an explicit JSON `null`. The `!= null` check below is therefore the
 * correct test for "plex has no current rating for this item".
 */
export async function fetchSectionGuidIndex(
  deps: PlexDeps, sectionKey: string, plexType: 1 | 2,
): Promise<Map<string, SectionIndexEntry>> {
  const index = new Map<string, SectionIndexEntry>()
  const PAGE = 200
  for (let start = 0; start < 20_000; start += PAGE) {
    const qs = new URLSearchParams({
      type: String(plexType), includeGuids: '1',
      'X-Plex-Container-Start': String(start), 'X-Plex-Container-Size': String(PAGE),
    })
    const b = await plexGet<{ MediaContainer?: { Metadata?: any[] } }>(
      deps, `/library/sections/${sectionKey}/all?${qs}`)
    const page = b.MediaContainer?.Metadata ?? []
    for (const m of page) {
      // The guard fetchAllLeaves already applies to its leaves, for the same
      // reason: an item with no usable ratingKey would stringify to the
      // literal "undefined" via String(undefined) and flow straight into a
      // real `PUT /:/rate?key=undefined`. Excluded, never indexed under its
      // guids where a later lookup could find it.
      if (m.ratingKey == null) continue
      // `Number(null) === 0`, which is finite -- an explicit JSON null would
      // silently become a rating of 0 instead of "no rating" if coerced first.
      // Nothing observed live sends an explicit null (see above), but the type
      // says `number | null` and the code must actually honour that, not just
      // the common case.
      const raw = m.userRating
      const ur = raw == null ? NaN : Number(raw)
      const entry: SectionIndexEntry = { ratingKey: String(m.ratingKey), userRating: Number.isFinite(ur) ? ur : null }
      for (const g of m.Guid ?? []) {
        if (g?.id && !index.has(g.id)) index.set(g.id, entry)
      }
    }
    if (page.length < PAGE) break
  }
  return index
}

export async function setPlexRating(deps: PlexDeps, ratingKey: string, rating: number): Promise<void> {
  const url = `${deps.plexUrl}/:/rate?key=${encodeURIComponent(ratingKey)}`
    + `&identifier=com.plexapp.plugins.library&rating=${rating}`
  const res = await (deps.fetchImpl ?? fetch)(url, {
    method: 'PUT', headers: { 'X-Plex-Token': deps.plexToken, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`plex rate ${ratingKey} -> ${res.status}`)
}
