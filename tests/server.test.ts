import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { loadConfig } from '../src/config.js'
import { createApp } from '../src/server.js'
import { createGate } from '../src/outbox.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const CONFIG = loadConfig({
  BINGERS_SESSION_COOKIE: 'TOK', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt',
} as NodeJS.ProcessEnv) // DRY_RUN defaults true

const app = () => createApp({
  config: CONFIG, store, auth: createAuth(store, 'TOK', 'UA'), gate: createGate(),
  fetchImpl: vi.fn(async () => new Response('{}', { status: 404 })) as any,
})

describe('routes', () => {
  it('reports health', async () => {
    const res = await app().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true, writesHalted: false, outboxDepth: 0 })
  })

  it('accepts a plex multipart post and returns 200', async () => {
    const f = new FormData()
    f.set('payload', JSON.stringify({ event: 'media.scrobble', Account: { title: 'someone-else' }, Metadata: { type: 'episode' } }))
    const res = await app().request('/plex', { method: 'POST', body: f })
    expect(res.status).toBe(200)
  })

  it('returns 200 even for an unparseable plex body so plex does not retry', async () => {
    const res = await app().request('/plex', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(200)
  })

  it('accepts pulsarr json and returns 200', async () => {
    const res = await app().request('/pulsarr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'watchlist.added', data: { addedBy: { username: 'nobody' }, content: { title: 'x', type: 'show', guids: [] } } }),
    })
    expect(res.status).toBe(200)
  })
})

// Payloads that pass the allowed-user filter and reach the handler (so a
// throw inside the handler -- not the "ignored"/"unparseable" early-return --
// is what's under test here.
const plexPayload = () => JSON.stringify({
  event: 'media.scrobble',
  Account: { title: 'plexuser' },
  Metadata: { type: 'movie', title: 'Some Movie', Guid: [{ id: 'tmdb://123' }], viewCount: 1, lastViewedAt: 1700000000 },
})
const pulsarrPayload = () => JSON.stringify({
  event: 'watchlist.added',
  data: { addedBy: { username: 'plexuser' }, content: { title: 'Some Show', type: 'show', guids: ['tmdb:123'] } },
})

describe('routes stay 200 when the handler or the store itself fails', () => {
  it('returns 200 and records a failure when handlePlex throws', async () => {
    store.getTitleId = () => { throw new Error('boom') }
    const f = new FormData()
    f.set('payload', plexPayload())
    const res = await app().request('/plex', { method: 'POST', body: f })
    expect(res.status).toBe(200)
    const failures = store.listFailures(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toContain('boom')
  })

  it('returns 200 and records a failure when handlePulsarr throws', async () => {
    store.getTitleId = () => { throw new Error('boom') }
    const res = await app().request('/pulsarr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: pulsarrPayload(),
    })
    expect(res.status).toBe(200)
    const failures = store.listFailures(1)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.reason).toContain('boom')
  })

  it('returns 200 for /plex even when recordFailure itself throws (store is what failed)', async () => {
    store.getTitleId = () => { throw new Error('boom') }
    store.recordFailure = () => { throw new Error('database is locked') }
    const f = new FormData()
    f.set('payload', plexPayload())
    const res = await app().request('/plex', { method: 'POST', body: f })
    expect(res.status).toBe(200)
  })

  it('returns 200 for /pulsarr even when recordFailure itself throws (store is what failed)', async () => {
    store.getTitleId = () => { throw new Error('boom') }
    store.recordFailure = () => { throw new Error('database is locked') }
    const res = await app().request('/pulsarr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: pulsarrPayload(),
    })
    expect(res.status).toBe(200)
  })
})
