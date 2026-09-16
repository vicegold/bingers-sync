export type PlexScrobble = {
  user: string; type: 'episode' | 'movie'; showRatingKey: string | null
  guids: { id: string }[]; grandparentTitle: string | null; title: string
  year: number | null; season: number | null; number: number | null
  viewCount: number; lastViewedAt: number | null
}

export type PulsarrEvent = {
  user: string; action: 'added' | 'removed'; title: string
  kind: 'show' | 'movie'; guids: { id: string }[]
}

export function parsePlexScrobble(form: FormData): PlexScrobble | null {
  const raw = form.get('payload')
  if (typeof raw !== 'string') return null
  let p: any
  try { p = JSON.parse(raw) } catch { return null }
  if (p?.event !== 'media.scrobble') return null
  const m = p.Metadata ?? {}
  if (m.type !== 'episode' && m.type !== 'movie') return null
  return {
    user: p.Account?.title ?? '',
    type: m.type,
    showRatingKey: m.grandparentRatingKey != null ? String(m.grandparentRatingKey) : null,
    guids: Array.isArray(m.Guid) ? m.Guid : [],
    grandparentTitle: m.grandparentTitle ?? null,
    title: m.title ?? '',
    year: m.year != null ? Number(m.year) : null,
    season: m.parentIndex != null ? Number(m.parentIndex) : null,
    number: m.index != null ? Number(m.index) : null,
    viewCount: m.viewCount != null ? Number(m.viewCount) : 1,
    lastViewedAt: m.lastViewedAt != null ? Number(m.lastViewedAt) : null,
  }
}

export function parsePulsarr(body: unknown): PulsarrEvent | null {
  const b = body as any
  const ev = b?.event
  if (ev !== 'watchlist.added' && ev !== 'watchlist.removed') return null
  const c = b?.data?.content ?? {}
  const guids: { id: string }[] = (c.guids ?? []).map((g: string) =>
    ({ id: g.includes('://') ? g : g.replace(':', '://') }))
  return {
    user: b?.data?.addedBy?.username ?? '',
    action: ev === 'watchlist.added' ? 'added' : 'removed',
    title: c.title ?? '',
    kind: c.type === 'movie' ? 'movie' : 'show',
    guids,
  }
}
