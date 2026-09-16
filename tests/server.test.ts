import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { loadConfig } from '../src/config.js'
import { createApp } from '../src/server.js'
import { createGate } from '../src/outbox.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const CONFIG = loadConfig({
  BINGERS_SESSION_COOKIE: 'TOK', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt', ALLOWED_USER: 'testuser',
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

  // C1 -- while the mirror is not fresh, backfill is suppressed. That has to be
  // visible from outside, or the service looks perfectly healthy while quietly
  // doing half its job.
  it('surfaces a cold mirror and the suppressed backfill in /health', async () => {
    const res = await app().request('/health')
    expect(await res.json()).toMatchObject({
      mirrorSyncedAt: null, mirrorFresh: false, backfillEnabled: false, mirrorMaxAgeMin: 60,
    })
  })

  it('reports the mirror fresh once a pull has succeeded', async () => {
    store.markMirrorSynced()
    const res = await app().request('/health')
    const b = await res.json() as any
    expect(b.mirrorFresh).toBe(true)
    expect(b.backfillEnabled).toBe(true)
    expect(b.mirrorSyncedAt).toBeTruthy()
  })

  it('reports the mirror stale again once the last pull ages out', async () => {
    store.markMirrorSynced(new Date(Date.now() - 61 * 60_000).toISOString())
    const b = await (await app().request('/health')).json() as any
    expect(b.mirrorFresh).toBe(false)
    expect(b.backfillEnabled).toBe(false)
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
  Account: { title: 'testuser' },
  Metadata: { type: 'movie', title: 'Some Movie', Guid: [{ id: 'tmdb://123' }], viewCount: 1, lastViewedAt: 1700000000 },
})
const pulsarrPayload = () => JSON.stringify({
  event: 'watchlist.added',
  data: { addedBy: { username: 'testuser' }, content: { title: 'Some Show', type: 'show', guids: ['tmdb:123'] } },
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
