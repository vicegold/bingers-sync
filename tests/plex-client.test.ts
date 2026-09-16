import { describe, it, expect, vi } from 'vitest'
import { fetchShowIds, fetchAllLeaves, parseGuids } from '../src/plex/client.js'

const deps = (f: any) => ({ plexUrl: 'http://plex.local:32400', plexToken: 'tok', fetchImpl: f as typeof fetch })
const stub = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))

describe('parseGuids', () => {
  it('parses the scheme://id form into a lookup', () => {
    expect(parseGuids([{ id: 'imdb://tt31491435' }, { id: 'tmdb://247522' }, { id: 'tvdb://446718' }]))
      .toEqual({ imdb: 'tt31491435', tmdb: '247522', tvdb: '446718' })
  })
  it('ignores schemes we do not match on', () => {
    expect(parseGuids([{ id: 'plex://show/abc' }, { id: 'tmdb://5' }])).toEqual({ tmdb: '5' })
  })
})

describe('fetchShowIds', () => {
  it('requests the show ratingKey with includeGuids and the token header', async () => {
    const f = stub({ MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://247522' }, { id: 'tvdb://446718' }] }] } })
    const ids = await fetchShowIds(deps(f), '90363')
    expect(ids).toEqual({ tmdb: '247522', tvdb: '446718' })
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('http://plex.local:32400/library/metadata/90363?includeGuids=1')
    expect(init.headers['X-Plex-Token']).toBe('tok')
  })

  it('returns an empty map when Plex knows no external ids', async () => {
    const f = stub({ MediaContainer: { Metadata: [{}] } })
    expect(await fetchShowIds(deps(f), '1')).toEqual({})
  })
})

describe('fetchAllLeaves', () => {
  it('maps episodes to season/number/viewCount/lastViewedAt', async () => {
    const f = stub({ MediaContainer: { Metadata: [
      { parentIndex: 1, index: 1, viewCount: 1, lastViewedAt: 1789000000, title: 'Pilot' },
      { parentIndex: 1, index: 2, title: 'Unwatched' },
      { parentIndex: 1, index: 3, viewCount: 2, lastViewedAt: 1789553428, title: 'Sales Contest' },
    ] } })
    const eps = await fetchAllLeaves(deps(f), '90363')
    expect((f as any).mock.calls[0][0]).toBe('http://plex.local:32400/library/metadata/90363/allLeaves')
    expect(eps).toHaveLength(3)
    expect(eps[1]).toEqual({ season: 1, number: 2, viewCount: 0, lastViewedAt: null, title: 'Unwatched' })
    expect(eps[2]).toEqual({ season: 1, number: 3, viewCount: 2, lastViewedAt: 1789553428, title: 'Sales Contest' })
  })
})
