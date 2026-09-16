import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { resolveTitle } from '../src/resolve.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
let store: Store
beforeEach(() => { store = openStore(':memory:') })

function routed(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
}

const deps = (f: any) => ({ store, fetchImpl: f as typeof fetch, searchMaxPages: 1 })

describe('resolveTitle', () => {
  it('accepts a candidate whose external ids intersect ours', async () => {
    const f = routed({ '/search/titles': fx('search-tires'), 'metadata@543408442fd2': fx('metadata-tires') })
    const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '247522' } })
    expect(r).toEqual({ titleId: '019f6bb9-65cf-78d1-b123-f9ed891fe9d7' })
  })

  it('refuses a title-and-year lookalike with no id intersection', async () => {
    const f = routed({ '/search/titles': fx('search-tires'), 'metadata@543408442fd2': fx('metadata-tires') })
    const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '999999' } })
    expect(r).toHaveProperty('failure')
  })

  it('caches every external id of a resolved title', async () => {
    const f = routed({ '/search/titles': fx('search-tires'), 'metadata@543408442fd2': fx('metadata-tires') })
    await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '247522' } })
    expect(store.getTitleId('tvdb', '446718', 'show')).toBe('019f6bb9-65cf-78d1-b123-f9ed891fe9d7')
    expect(store.getTitleId('imdb', 'tt31491435', 'show')).toBe('019f6bb9-65cf-78d1-b123-f9ed891fe9d7')
  })

  it('serves a cache hit without touching the network', async () => {
    store.putTitleMapping([{ source: 'tmdb', extId: '247522', kind: 'show', titleId: 'CACHED', title: null, year: null }])
    const f = vi.fn()
    const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '247522' } })
    expect(r).toEqual({ titleId: 'CACHED' })
    expect(f).not.toHaveBeenCalled()
  })

  it('only considers candidates of the matching kind', async () => {
    // the movie result carries tmdb 1726052; asking for a show with that id must not match
    const f = routed({ '/search/titles': fx('search-tires'), 'metadata@9ed3c7faa7c9': { external_ids: [{ id: '1726052', source: 'tmdb' }] } })
    const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '1726052' } })
    expect(r).toHaveProperty('failure')
  })

  it('fails cleanly when search returns nothing', async () => {
    const f = routed({ '/search/titles': { results: [] } })
    const r = await resolveTitle(deps(f), { title: 'Nothing', kind: 'show', ids: { tmdb: '1' } })
    expect(r).toHaveProperty('failure')
  })
})
