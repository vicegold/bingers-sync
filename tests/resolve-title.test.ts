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

  // I6 -- a 503 while checking the TRUE candidate is not evidence of a
  // no-match. Filing it as `no external id match` loses the event forever,
  // because nothing replays `failures`.
  describe('a candidate we could not check', () => {
    // search-tires returns the show (metadata@543408442fd2) plus a movie; only
    // the show's metadata fetch is attempted for kind 'show', and it 503s.
    const flaky = vi.fn(async (url: string) => {
      if (url.includes('/search/titles')) return new Response(JSON.stringify(fx('search-tires')), { status: 200 })
      return new Response('upstream boom', { status: 503 })
    })

    it('is reported as inconclusive and retryable, not as a confident no-match', async () => {
      const r = await resolveTitle(deps(flaky), { title: 'Tires', kind: 'show', ids: { tmdb: '247522' } }) as any
      expect(r.failure).toMatch(/inconclusive/i)
      expect(r.failure).not.toMatch(/^no external id match/)
      expect(r.retryable).toBe(true)
    })

    it('carries enough detail to replay the lookup by hand', async () => {
      const r = await resolveTitle(deps(flaky), { title: 'Tires', kind: 'show', ids: { tmdb: '247522' } }) as any
      expect(r.details).toMatchObject({ title: 'Tires', kind: 'show', ids: { tmdb: '247522' } })
      expect(r.details.unchecked[0]).toMatchObject({ titleId: '019f6bb9-65cf-78d1-b123-f9ed891fe9d7', metadata: '543408442fd2' })
      expect(r.details.unchecked[0].error).toMatch(/503/)
    })

    it('still reports a plain no-match when every candidate WAS checked', async () => {
      const f = routed({ '/search/titles': fx('search-tires'), 'metadata@543408442fd2': fx('metadata-tires') })
      const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '999999' } }) as any
      expect(r.failure).toMatch(/^no external id match/)
      expect(r.retryable).toBeUndefined()
    })
  })
})
