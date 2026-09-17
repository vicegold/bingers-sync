import { describe, it, expect, vi } from 'vitest'
import { fetchSections, fetchRatedSince, fetchSectionGuidIndex, setPlexRating } from '../src/plex/client.js'

const deps = (f: any) => ({ plexUrl: 'http://plex.local:32400', plexToken: 'tok', fetchImpl: f as typeof fetch })
const stub = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('fetchSections', () => {
  it('returns every section with its type, so movie sections are not missed', async () => {
    const f = stub({ MediaContainer: { Directory: [
      { key: '2', type: 'movie', title: 'Filme' },
      { key: '1', type: 'show', title: 'Serien' },
      { key: '8', type: 'artist', title: 'Hörbücher' },
    ] } })
    const s = await fetchSections(deps(f))
    expect(s).toEqual([
      { key: '2', type: 'movie', title: 'Filme' },
      { key: '1', type: 'show', title: 'Serien' },
      { key: '8', type: 'artist', title: 'Hörbücher' },
    ])
    expect((f as any).mock.calls[0][0]).toBe('http://plex.local:32400/library/sections')
  })
})

describe('fetchRatedSince', () => {
  it('builds the cursored URL with the right type and sort', async () => {
    const f = stub({ MediaContainer: { Metadata: [] } })
    await fetchRatedSince(deps(f), '1', 4, 1764000000)
    const url = (f as any).mock.calls[0][0] as string
    expect(url).toContain('/library/sections/1/all')
    expect(url).toContain('type=4')
    expect(url).toContain('lastRatedAt')
    expect(url).toContain('1764000000')
    expect(url).toContain('sort=lastRatedAt%3Adesc')
  })

  it('maps rated items, keeping the fields both directions need', async () => {
    const f = stub({ MediaContainer: { Metadata: [
      { ratingKey: '97013', type: 'episode', title: 'Episode 4', userRating: 7, lastRatedAt: 1789592016,
        grandparentRatingKey: '90363', parentIndex: 1, index: 4, Guid: [{ id: 'tmdb://1' }] },
      { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 9, lastRatedAt: 1764000001,
        Guid: [{ id: 'tmdb://467244' }, { id: 'imdb://tt7160372' }] },
    ] } })
    const r = await fetchRatedSince(deps(f), '1', 4, 0)
    expect(r[0]).toEqual({ ratingKey: '97013', type: 'episode', title: 'Episode 4', userRating: 7,
      lastRatedAt: 1789592016, guids: [{ id: 'tmdb://1' }], grandparentRatingKey: '90363', parentIndex: 1, index: 4 })
    expect(r[1]!.type).toBe('movie')
    expect(r[1]!.grandparentRatingKey).toBeNull()
    expect(r[1]!.parentIndex).toBeNull()
    expect(r[1]!.index).toBeNull()
    expect(r[1]!.guids).toHaveLength(2)
  })

  it('skips an item with no usable userRating rather than emitting a NaN', async () => {
    const f = stub({ MediaContainer: { Metadata: [
      { ratingKey: '1', type: 'episode', title: 'x', lastRatedAt: 1 },
      { ratingKey: '2', type: 'episode', title: 'y', userRating: 8, lastRatedAt: 2 },
    ] } })
    const r = await fetchRatedSince(deps(f), '1', 4, 0)
    expect(r.map(i => i.ratingKey)).toEqual(['2'])
  })

  it('returns an empty list on an unexpected shape rather than throwing', async () => {
    expect(await fetchRatedSince(deps(stub({})), '1', 4, 0)).toEqual([])
  })

  // Confirmed live: without includeGuids=1 the server omits `Guid` entirely
  // (movies and episodes both), so parseGuids(item.guids) always yields {} and
  // the whole Plex->Bingers rating path silently resolves nothing.
  it('always requests includeGuids=1, without which Guid comes back empty', async () => {
    const f = stub({ MediaContainer: { Metadata: [] } })
    await fetchRatedSince(deps(f), '1', 4, 0)
    const url = (f as any).mock.calls[0][0] as string
    expect(url).toContain('includeGuids=1')
  })
})

describe('fetchSectionGuidIndex', () => {
  it('does NOT filter on lastRatedAt — an unrated movie must still be findable', async () => {
    const f = stub({ MediaContainer: { Metadata: [
      { ratingKey: '7727', Guid: [{ id: 'tmdb://671' }, { id: 'imdb://tt0241527' }] },
    ] } })
    const idx = await fetchSectionGuidIndex(deps(f), '2', 1)
    expect(idx.get('tmdb://671')).toEqual({ ratingKey: '7727', userRating: null })
    expect(idx.get('imdb://tt0241527')).toEqual({ ratingKey: '7727', userRating: null })
    const url = (f as any).mock.calls[0][0] as string
    expect(url).not.toContain('lastRatedAt')
    expect(url).toContain('includeGuids=1')
  })

  it('carries the item\'s CURRENT live userRating alongside its ratingKey', async () => {
    const f = stub({ MediaContainer: { Metadata: [
      { ratingKey: '7727', userRating: 9, Guid: [{ id: 'tmdb://671' }] },
    ] } })
    const idx = await fetchSectionGuidIndex(deps(f), '2', 1)
    expect(idx.get('tmdb://671')).toEqual({ ratingKey: '7727', userRating: 9 })
  })

  it('treats an explicit JSON null userRating as null, not 0 (Number(null) === 0)', async () => {
    const f = stub({ MediaContainer: { Metadata: [
      { ratingKey: '1', userRating: null, Guid: [{ id: 'tmdb://1' }] },
    ] } })
    const idx = await fetchSectionGuidIndex(deps(f), '2', 1)
    expect(idx.get('tmdb://1')).toEqual({ ratingKey: '1', userRating: null })
  })

  // The guard fetchAllLeaves already documents and applies. Without it the
  // entry is indexed as the literal string "undefined", which a caller then
  // hands to setPlexRating -- a real `PUT /:/rate?key=undefined`.
  it('excludes an item with no usable ratingKey rather than indexing "undefined"', async () => {
    const f = stub({ MediaContainer: { Metadata: [
      { Guid: [{ id: 'tmdb://1' }] },
      { ratingKey: '7727', Guid: [{ id: 'tmdb://2' }] },
    ] } })
    const idx = await fetchSectionGuidIndex(deps(f), '2', 1)
    expect(idx.get('tmdb://1')).toBeUndefined()
    expect([...idx.values()].some(e => e.ratingKey === 'undefined')).toBe(false)
    expect(idx.get('tmdb://2')).toEqual({ ratingKey: '7727', userRating: null })
  })

  it('stops paging when a short page comes back', async () => {
    const f = stub({ MediaContainer: { Metadata: [{ ratingKey: '1', Guid: [{ id: 'tmdb://1' }] }] } })
    await fetchSectionGuidIndex(deps(f), '2', 1)
    expect((f as any).mock.calls).toHaveLength(1)
  })
})

describe('setPlexRating', () => {
  it('PUTs the verified rate URL', async () => {
    const f = stub({})
    await setPlexRating(deps(f), '90366', 8)
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('http://plex.local:32400/:/rate?key=90366&identifier=com.plexapp.plugins.library&rating=8')
    expect(init.method).toBe('PUT')
  })

  it('throws on a non-2xx so the caller can record it', async () => {
    await expect(setPlexRating(deps(stub({}, 404)), '1', 8)).rejects.toThrow(/404/)
  })
})
