// tests/bingers-catalog.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { searchTitles, fetchVersions, fetchMetadata, fetchSeason, externalIdMap } from '../src/bingers/catalog.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
const stub = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

describe('searchTitles', () => {
  it('hits the public endpoint with no cookie and returns results', async () => {
    const f = stub(fx('search-tires'))
    const r = await searchTitles('tires', 0, f as any)
    expect(r).toHaveLength(2)
    expect(r[0]!.id).toBe('019f6bb9-65cf-78d1-b123-f9ed891fe9d7')
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('https://api.bingers.app/search/titles?q=tires&page=0&lang=de')
    expect(init?.headers?.Cookie).toBeUndefined()
  })

  it('throws on a non-200 so the caller can retry', async () => {
    await expect(searchTitles('tires', 0, stub({}, 500) as any)).rejects.toThrow(/500/)
  })
})

describe('catalog paths', () => {
  it('builds the kind@hash.json path for metadata', async () => {
    const f = stub(fx('metadata-tires'))
    await fetchMetadata('T1', 'abc123', f as any)
    expect((f as any).mock.calls[0][0])
      .toBe('https://catalog.bingers.app/catalog/T1/metadata@abc123.json')
  })

  it('builds the season-N@hash.json path for a season', async () => {
    const f = stub(fx('season1-tires'))
    const eps = await fetchSeason('T1', 1, 'dddd00000004', f as any)
    expect((f as any).mock.calls[0][0])
      .toBe('https://catalog.bingers.app/catalog/T1/season-1@dddd00000004.json')
    expect(eps).toHaveLength(3)
    expect(eps[2]).toMatchObject({ n: 3, id: '019f6bb9-65fd-7ef3-8053-8e3333a9f117' })
  })

  it('returns the files map from versions.json', async () => {
    const f = stub(fx('versions-tires'))
    const v = await fetchVersions('T1', f as any)
    expect(v.metadata).toBe('543408442fd2')
    expect(v.seasons).toEqual({ '0': 'cccc00000003', '1': 'dddd00000004' })
  })
})

describe('externalIdMap', () => {
  it('normalises the external_ids array to a lookup', () => {
    expect(externalIdMap(fx('metadata-tires'))).toEqual({
      imdb: 'tt31491435', tmdb: '247522', tvdb: '446718',
    })
  })

  it('ignores sources we do not match on', () => {
    const m = { external_ids: [{ id: 'Q1', source: 'wikidata' }, { id: '5', source: 'tmdb' }] } as any
    expect(externalIdMap(m)).toEqual({ tmdb: '5' })
  })

  it('keeps the first id when a source appears more than once', () => {
    const m = {
      external_ids: [
        { id: '111', source: 'tmdb' },
        { id: '222', source: 'tmdb' },
      ],
    } as any
    expect(externalIdMap(m)).toEqual({ tmdb: '111' })
  })
})

describe('error handling', () => {
  it('throws on a non-200 so the caller can retry', async () => {
    await expect(fetchVersions('T1', stub({}, 500) as any)).rejects.toThrow(/500/)
  })
})
