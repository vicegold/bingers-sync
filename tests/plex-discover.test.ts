import { describe, it, expect, vi } from 'vitest'
import { searchDiscover, discoverIds, addToWatchlist, ratingKeyFromGuid, DISCOVER_TIMEOUT_MS } from '../src/plex/discover.js'

const deps = (f: any) => ({ plexToken: 'tok', fetchImpl: f as typeof fetch })
const stub = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status }))

describe('ratingKeyFromGuid', () => {
  it('takes the last path segment', () => {
    expect(ratingKeyFromGuid('plex://show/65df741280e2a6434615dcf0')).toBe('65df741280e2a6434615dcf0')
    expect(ratingKeyFromGuid('plex://movie/abc')).toBe('abc')
  })
})

// Without an explicit deadline these inherit undici's 300s header timeout, and
// a reconcile is up to REVERSE_BATCH x 7 of them back to back -- one degraded
// discover host would stall the loop for the better part of an hour.
describe('request deadline', () => {
  it('gives every discover call an abort signal', async () => {
    const f = stub({ MediaContainer: { SearchResults: [] } })
    await searchDiscover(deps(f), 'q', 'show')
    await discoverIds(deps(f), 'k')
    await addToWatchlist(deps(f), 'k')
    expect((f as any).mock.calls).toHaveLength(3)
    for (const [, init] of (f as any).mock.calls) {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      expect(init.signal.aborted).toBe(false)
    }
    expect(DISCOVER_TIMEOUT_MS).toBeLessThanOrEqual(30_000)
  })

  it('aborts a hung request instead of waiting on the transport default', async () => {
    const seen: AbortSignal[] = []
    // A fetch that never settles on its own -- exactly the degraded-discover
    // case. Only the signal can end it.
    const hang = vi.fn((_u: string, init: any) => {
      seen.push(init.signal)
      return new Promise<Response>((_res, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason)))
    })
    await expect(discoverIds({ plexToken: 'tok', fetchImpl: hang as any, timeoutMs: 5 }, 'k')).rejects.toThrow()
    expect(seen[0]!.aborted).toBe(true)
  })
})

describe('searchDiscover', () => {
  it('sends searchProviders=discover — omitting it returns 400 from the real API', async () => {
    const f = stub({ MediaContainer: { SearchResults: [] } })
    await searchDiscover(deps(f), 'The Mentalist', 'show')
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toContain('https://discover.provider.plex.tv/library/search')
    expect(url).toContain('searchProviders=discover')
    expect(url).toContain('searchTypes=tv')
    expect(url).toContain('query=The%20Mentalist')
    expect(init.headers['X-Plex-Token']).toBe('tok')
  })

  it('maps a movie kind to searchTypes=movies', async () => {
    const f = stub({ MediaContainer: { SearchResults: [] } })
    await searchDiscover(deps(f), 'Titanic', 'movie')
    expect((f as any).mock.calls[0][0]).toContain('searchTypes=movies')
  })

  it('extracts ratingKeys from nested SearchResults', async () => {
    const f = stub({ MediaContainer: { SearchResults: [{ SearchResult: [
      { Metadata: { guid: 'plex://show/5d9c08353c3f87001f34a531', title: 'The Mentalist', year: 2008 } },
      { Metadata: { guid: 'plex://show/aaa', title: 'Other', year: 2019 } },
    ] }] } })
    const r = await searchDiscover(deps(f), 'The Mentalist', 'show')
    expect(r).toEqual([
      { ratingKey: '5d9c08353c3f87001f34a531', title: 'The Mentalist', year: 2008 },
      { ratingKey: 'aaa', title: 'Other', year: 2019 },
    ])
  })

  it('returns an empty list rather than throwing when the shape is unexpected', async () => {
    expect(await searchDiscover(deps(stub({})), 'x', 'show')).toEqual([])
  })
})

describe('discoverIds', () => {
  it('requests includeGuids and normalises the Guid array', async () => {
    const f = stub({ MediaContainer: { Metadata: [{ Guid: [
      { id: 'imdb://tt1196946' }, { id: 'tmdb://5920' }, { id: 'tvdb://82459' },
    ] }] } })
    const ids = await discoverIds(deps(f), '5d9c0835')
    expect(ids).toEqual({ imdb: 'tt1196946', tmdb: '5920', tvdb: '82459' })
    expect((f as any).mock.calls[0][0]).toBe(
      'https://discover.provider.plex.tv/library/metadata/5d9c0835?includeGuids=1')
  })

  it('returns an empty map when discover knows no external ids', async () => {
    expect(await discoverIds(deps(stub({ MediaContainer: { Metadata: [{}] } })), 'k')).toEqual({})
  })
})

describe('addToWatchlist', () => {
  it('PUTs the action with the ratingKey', async () => {
    const f = stub({})
    await addToWatchlist(deps(f), 'k1')
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('https://discover.provider.plex.tv/actions/addToWatchlist?ratingKey=k1')
    expect(init.method).toBe('PUT')
  })

  it('throws on a non-2xx so the caller can record it', async () => {
    await expect(addToWatchlist(deps(stub({}, 500)), 'k1')).rejects.toThrow(/500/)
  })
})
