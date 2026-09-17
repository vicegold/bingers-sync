import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { titleExternalIds } from '../src/resolve.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
let store: Store
beforeEach(() => { store = openStore(':memory:') })

function routed(routes: Record<string, unknown>, counter?: { n: number }) {
  return vi.fn(async (url: string) => {
    if (counter) counter.n++
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
}
const deps = (f: any) => ({ store, fetchImpl: f as typeof fetch, searchMaxPages: 1 })
const ROUTES = { 'versions.json': fx('versions-tires'), 'metadata@543408442fd2': fx('metadata-tires') }

describe('titleExternalIds', () => {
  it('serves cached ids without any network call', async () => {
    store.putTitleMapping([{ source: 'tmdb', extId: '247522', kind: 'show', titleId: 'T1', title: 'Tires', year: 2024 }])
    const f = vi.fn()
    const r = await titleExternalIds(deps(f), 'T1', 'show')
    expect(r).toEqual({ ids: { tmdb: '247522' }, title: 'Tires', year: 2024 })
    expect(f).not.toHaveBeenCalled()
  })

  it('fetches the catalog for a title that was never resolved outward, and caches it', async () => {
    const c = { n: 0 }
    const f = routed(ROUTES, c)
    const r = await titleExternalIds(deps(f), '019f6bb9-65cf-78d1-b123-f9ed891fe9d7', 'show')
    expect(r).toMatchObject({ ids: { tmdb: '247522', tvdb: '446718', imdb: 'tt31491435' }, title: 'Tires' })
    expect(c.n).toBeGreaterThan(0)

    const before = c.n
    await titleExternalIds(deps(f), '019f6bb9-65cf-78d1-b123-f9ed891fe9d7', 'show')
    expect(c.n).toBe(before) // second call is cache-only
  })

  it('returns a retryable failure when the catalog is unreachable', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 503 }))
    const r = await titleExternalIds(deps(f), 'T9', 'show')
    expect(r).toHaveProperty('failure')
    expect((r as any).retryable).toBe(true)
  })
})
