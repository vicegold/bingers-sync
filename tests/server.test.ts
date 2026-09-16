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
