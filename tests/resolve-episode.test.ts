import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { resolveEpisode } from '../src/resolve.js'

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

const ROUTES = {
  'versions.json': fx('versions-tires'),
  'season-1@dddd00000004.json': fx('season1-tires'),
  'season-0@cccc00000003.json': { episodes: [{ n: 1, abs: 0, id: 'SPECIAL1', title: 'Behind the scenes', aired: '2024-05-01' }] },
}
const deps = (f: any) => ({ store, fetchImpl: f as typeof fetch, searchMaxPages: 1, catalogTtlHours: 24 })

describe('resolveEpisode', () => {
  it('resolves a season/number pair to the bingers episode id', async () => {
    const r = await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 1, number: 3 })
    expect(r).toEqual({ episodeId: '019f6bb9-65fd-7ef3-8053-8e3333a9f117' })
  })

  it('hydrates every season on first resolution, including season 0', async () => {
    await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 1, number: 3 })
    expect(store.getEpisodeId('T1', 1, 1)).toBe('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
    expect(store.getEpisodeId('T1', 0, 1)).toBe('SPECIAL1')
  })

  it('makes no network calls at all on a second episode of the same show', async () => {
    const c = { n: 0 }
    const f = routed(ROUTES, c)
    await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 3 })
    const afterFirst = c.n
    expect(afterFirst).toBeGreaterThan(0)
    await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 1 })
    expect(c.n).toBe(afterFirst)
  })

  it('fails cleanly for an episode the catalog does not have', async () => {
    const r = await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 9, number: 9 }) as any
    expect(r).toHaveProperty('failure')
    expect(r.retryable).toBeUndefined() // season 9 genuinely does not exist
  })

  // I6 -- the same defect on the episode side: one season's fetch failing must
  // not read as "that episode does not exist".
  it('reports an unfetchable season as inconclusive rather than as a missing episode', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('versions.json')) return new Response(JSON.stringify(fx('versions-tires')), { status: 200 })
      if (url.includes('season-1@')) return new Response('upstream boom', { status: 503 })
      return new Response(JSON.stringify({ episodes: [] }), { status: 200 })
    })
    const r = await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 3 }) as any
    expect(r.failure).toMatch(/inconclusive/i)
    expect(r.failure).not.toMatch(/^no episode/)
    expect(r.retryable).toBe(true)
    expect(r.details).toMatchObject({ titleId: 'T1', season: 1, number: 3 })
  })

  it('reports a failed versions.json as retryable', async () => {
    const f = vi.fn(async () => new Response('gone', { status: 502 }))
    const r = await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 3 }) as any
    expect(r.retryable).toBe(true)
  })

  it('re-hydrates when an episode is missing, picking up a newly aired one', async () => {
    const f1 = routed(ROUTES)
    await resolveEpisode(deps(f1), { titleId: 'T1', season: 1, number: 3 })

    const grown = { episodes: [...fx('season1-tires').episodes, { n: 4, abs: 4, id: 'NEW4', title: 'New', aired: '2026-01-01' }] }
    const f2 = routed({
      'versions.json': { titleId: 'T1', kind: 'show', files: { metadata: 'm', seasons: { '0': 'cccc00000003', '1': 'HASHCHANGED' } } },
      'season-1@HASHCHANGED.json': grown,
      'season-0@cccc00000003.json': ROUTES['season-0@cccc00000003.json'],
    })
    const r = await resolveEpisode(deps(f2), { titleId: 'T1', season: 1, number: 4 })
    expect(r).toEqual({ episodeId: 'NEW4' })
  })
})

// ---------------------------------------------------------------------------
// Task 15 -- CATALOG_TTL_HOURS. Two separate behaviours are pinned here:
// (a) a re-check of versions.json re-fetches ONLY seasons whose hash moved,
// (b) catalogTtlHours decides when a proactive re-check is due at all.
// ---------------------------------------------------------------------------

const NEW4 = { n: 4, abs: 4, id: 'NEW4', title: 'New', aired: '2026-01-01' }
const GROWN_ROUTES = () => ({
  'versions.json': { titleId: 'T1', kind: 'show', files: { metadata: 'm', seasons: { '0': 'cccc00000003', '1': 'HASHCHANGED' } } },
  'season-1@HASHCHANGED.json': { episodes: [...fx('season1-tires').episodes, NEW4] },
  'season-0@cccc00000003.json': ROUTES['season-0@cccc00000003.json'],
})
const urlsOf = (f: any) => (f.mock.calls as any[][]).map(c => String(c[0]))
const countMatching = (f: any, frag: string) => urlsOf(f).filter(u => u.includes(frag)).length

async function firstHydrate() {
  await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 1, number: 3 })
}

describe('hydrateEpisodes hash diffing', () => {
  it('does NOT re-fetch a season whose hash is unchanged', async () => {
    await firstHydrate()
    // Season 0's hash is byte-identical to the stored one; only season 1 moved.
    const f = routed(GROWN_ROUTES())
    await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 4 })
    expect(countMatching(f, 'season-0@')).toBe(0)
  })

  it('re-fetches exactly the season whose hash changed', async () => {
    await firstHydrate()
    const f = routed(GROWN_ROUTES())
    const r = await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 4 })
    expect(r).toEqual({ episodeId: 'NEW4' })
    expect(countMatching(f, 'season-1@HASHCHANGED')).toBe(1)
    expect(countMatching(f, 'versions.json')).toBe(1)
  })

  it('fetches every season on a first-ever hydrate, having no stored hashes to diff against', async () => {
    const f = routed(ROUTES)
    await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 3 })
    expect(countMatching(f, 'season-0@cccc00000003')).toBe(1)
    expect(countMatching(f, 'season-1@dddd00000004')).toBe(1)
  })

  // Skipping on an unchanged hash is only safe if the stored hash really does
  // describe what episode_map holds. A season we failed to download must not
  // be recorded as held, or one 503 becomes a permanent hole.
  it('retries a season whose fetch failed instead of trusting a hash it never downloaded', async () => {
    const f1 = vi.fn(async (url: string) => {
      if (url.includes('versions.json')) return new Response(JSON.stringify(fx('versions-tires')), { status: 200 })
      if (url.includes('season-1@')) return new Response('upstream boom', { status: 503 })
      return new Response(JSON.stringify({ episodes: [] }), { status: 200 })
    })
    await resolveEpisode(deps(f1), { titleId: 'T1', season: 1, number: 3 })

    const f2 = routed(ROUTES)
    const r = await resolveEpisode(deps(f2), { titleId: 'T1', season: 1, number: 3 })
    expect(r).toEqual({ episodeId: '019f6bb9-65fd-7ef3-8053-8e3333a9f117' })
    expect(countMatching(f2, 'season-1@dddd00000004')).toBe(1)
    expect(countMatching(f2, 'season-0@')).toBe(0) // season 0 DID land the first time
  })
})

describe('catalogTtlHours', () => {
  it('re-checks versions.json for a cached episode once the TTL has elapsed, without re-fetching unchanged seasons', async () => {
    await firstHydrate()
    const f = routed(ROUTES)
    const r = await resolveEpisode({ ...deps(f), catalogTtlHours: 0 }, { titleId: 'T1', season: 1, number: 3 })
    expect(r).toEqual({ episodeId: '019f6bb9-65fd-7ef3-8053-8e3333a9f117' })
    expect(countMatching(f, 'versions.json')).toBe(1)
    expect(countMatching(f, 'season-')).toBe(0)
  })

  it('makes no call at all for a cached episode while the TTL has not elapsed', async () => {
    await firstHydrate()
    const f = routed(ROUTES)
    await resolveEpisode({ ...deps(f), catalogTtlHours: 24 }, { titleId: 'T1', season: 1, number: 3 })
    expect(f).not.toHaveBeenCalled()
  })

  it('picks up a newly aired episode on a MISS however long the TTL is', async () => {
    await firstHydrate()
    const f = routed(GROWN_ROUTES())
    const r = await resolveEpisode({ ...deps(f), catalogTtlHours: 99999 }, { titleId: 'T1', season: 1, number: 4 })
    expect(r).toEqual({ episodeId: 'NEW4' })
  })

  it('keeps returning the cached episode when a due TTL re-check fails outright', async () => {
    await firstHydrate()
    const f = vi.fn(async () => new Response('gone', { status: 502 }))
    const r = await resolveEpisode({ ...deps(f), catalogTtlHours: 0 }, { titleId: 'T1', season: 1, number: 3 })
    expect(r).toEqual({ episodeId: '019f6bb9-65fd-7ef3-8053-8e3333a9f117' })
  })
})
