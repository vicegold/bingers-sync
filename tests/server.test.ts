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

// ---------------------------------------------------------------------------
// /setup -- self-closing. It exists to acquire a session cookie, so it answers
// only while there is no working one. See src/bingers/magic-link.ts for why
// redemption is reachable from a container when sending a link is not.
// ---------------------------------------------------------------------------

const NO_COOKIE = loadConfig({
  PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt', ALLOWED_USER: 'testuser',
} as NodeJS.ProcessEnv)

const VERIFIED = () => new Response(null, {
  status: 302,
  headers: { 'set-cookie': '__Secure-better-auth.session_token=FRESH; Max-Age=31536000; Path=/; Secure' },
})

const setupApp = (opts: { cookie?: string; gate?: ReturnType<typeof createGate>; fetchImpl?: any } = {}) => {
  const gate = opts.gate ?? createGate()
  const fetchImpl = opts.fetchImpl ?? vi.fn(async (url: any) =>
    String(url).includes('/auth/magic-link/verify')
      ? VERIFIED()
      : new Response(JSON.stringify({ session: { expiresAt: '2027-09-16T08:20:14.792Z' } }), { status: 200 }))
  const auth = createAuth(store, opts.cookie ?? '', 'UA')
  return { gate, auth, fetchImpl, app: createApp({ config: NO_COOKIE, store, auth, gate, fetchImpl }) }
}

const paste = (link: string) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ link }).toString(),
})

const LINK = 'https://bingers.app/m?token=JGuDntNbHscqfMOINyLoLIZrrCDVjNzu'

describe('/setup', () => {
  it('serves the setup page while there is no session', async () => {
    const res = await setupApp().app.request('/setup')
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('<form')
  })

  it('closes itself once a session exists', async () => {
    const res = await setupApp({ cookie: 'ALREADY' }).app.request('/setup')
    expect(res.status).toBe(404)
  })

  // The other way in: the session was fine and went dead. A 401 anywhere on the
  // write path halts the gate, and that is exactly when setup has to reopen --
  // otherwise re-authenticating means editing .env and restarting again.
  it('reopens when the write gate has halted on a dead session', async () => {
    const gate = createGate()
    gate.halt('bingers 401')
    const res = await setupApp({ cookie: 'STALE', gate }).app.request('/setup')
    expect(res.status).toBe(200)
  })

  it('redeems a pasted link and persists the session', async () => {
    const { app, auth } = setupApp()
    const res = await app.request('/setup', paste(LINK))
    expect(res.status).toBe(200)
    expect(auth.cookieHeader()).toBe('__Secure-better-auth.session_token=FRESH')
    expect(store.getAuthState()!.cookie).toBe('FRESH')
  })

  // Without this the service sits halted until the next daily heartbeat, which
  // makes a successful setup look like it did nothing.
  it('resumes writing once a session has been acquired', async () => {
    const gate = createGate()
    gate.halt('bingers 401')
    const { app } = setupApp({ cookie: 'STALE', gate })
    await app.request('/setup', paste(LINK))
    expect(gate.halted).toBe(false)
  })

  it('records how long the new session lasts, so /health is right immediately', async () => {
    const { app } = setupApp()
    await app.request('/setup', paste(LINK))
    expect(store.getAuthState()!.expiresAt).toBe('2027-09-16T08:20:14.792Z')
  })

  it('rejects a paste with no token in it and stays open', async () => {
    const { app, auth } = setupApp()
    const res = await app.request('/setup', paste('I could not find the link'))
    expect(res.status).toBe(400)
    expect(auth.hasSession()).toBe(false)
    expect((await setupApp().app.request('/setup')).status).toBe(200)
  })

  // A token is single-use: tapping the email instead of copying it spends the
  // token, and the paste that follows arrives already dead.
  it('reports a spent token without claiming success', async () => {
    const { app, auth } = setupApp({ fetchImpl: vi.fn(async () => new Response('{}', { status: 400 })) })
    const res = await app.request('/setup', paste(LINK))
    expect(res.status).toBe(502)
    expect(auth.hasSession()).toBe(false)
  })

  it('refuses a paste once a session already exists', async () => {
    const { app } = setupApp({ cookie: 'ALREADY' })
    expect((await app.request('/setup', paste(LINK))).status).toBe(404)
  })

  it('tells /health whether setup is still needed', async () => {
    expect(await (await setupApp().app.request('/health')).json()).toMatchObject({ setupRequired: true })
    expect(await (await setupApp({ cookie: 'TOK' }).app.request('/health')).json())
      .toMatchObject({ setupRequired: false })
  })

  // The commonest way a session ends, and the one the write gate never saw: it
  // simply ran out. The gate closes only on a 401 from a real WRITE, and under
  // DRY_RUN -- the default -- no write ever reaches the network, so nothing
  // could reopen this page at all.
  it('reopens when the session has expired, with no 401 anywhere', async () => {
    store.putAuthState({
      cookie: 'STALE', expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
      rotatedAt: null, checkedAt: null, accountId: null,
    })
    const { app } = setupApp()
    expect((await app.request('/setup')).status).toBe(200)
    expect(await (await app.request('/health')).json()).toMatchObject({ setupRequired: true })
  })

  // A 401 on a READ (the scheduled pull, the daily heartbeat) says the session
  // is dead just as loudly as one on a write, but it never halts the gate.
  it('reopens after a 401 on a read, which never halts the write gate', async () => {
    const { app, auth, gate } = setupApp({ cookie: 'STALE' })
    expect((await app.request('/setup')).status).toBe(404)
    auth.noteUnauthorized()
    expect(gate.halted).toBe(false)
    expect((await app.request('/setup')).status).toBe(200)
  })

  // A form POST is CORS-simple: no preflight, and the attacker never needs to
  // read the reply. Any page the operator's browser loads could submit one.
  it('refuses a cross-origin form post', async () => {
    const { app, auth } = setupApp()
    const res = await app.request('/setup', {
      ...paste(LINK),
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.test' },
    })
    expect(res.status).toBe(403)
    expect(auth.hasSession()).toBe(false)
  })

  // The gate used to reopen before anything checked the new cookie, so a
  // session that failed its only health check resumed writing, 401'd on the
  // next scrobble and re-halted with a second notification.
  it('does not resume writing on a cookie whose own session lookup fails', async () => {
    const gate = createGate()
    gate.halt('bingers 401')
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).includes('/auth/magic-link/verify') ? VERIFIED() : new Response('{}', { status: 401 }))
    const { app, auth } = setupApp({ cookie: 'STALE', gate, fetchImpl })

    const res = await app.request('/setup', paste(LINK))
    expect(res.status).toBe(502)
    expect(gate.halted).toBe(true)
    // and nothing was half-adopted: the container is on the session it had
    expect(auth.cookieHeader()).toBe('__Secure-better-auth.session_token=STALE')
    expect((await app.request('/setup')).status).toBe(200)
  })

  // Being self-closing is not by itself what stops a LAN neighbour re-pointing
  // the sync: the page is legitimately open for all of first boot and every
  // session death, and /health says exactly when. The account binding is.
  it('refuses a link for a different bingers account than the one it syncs', async () => {
    store.putAuthState({ cookie: 'STALE', expiresAt: null, rotatedAt: null, checkedAt: null, accountId: 'mine' })
    const gate = createGate()
    gate.halt('bingers 401')
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).includes('/auth/magic-link/verify')
        ? VERIFIED()
        : new Response(JSON.stringify({ session: { expiresAt: '2027-09-16T08:20:14.792Z' }, user: { id: 'theirs' } }), { status: 200 }))
    const { app, auth } = setupApp({ gate, fetchImpl })

    const res = await app.request('/setup', paste(LINK))
    expect(res.status).toBe(403)
    expect(auth.cookieHeader()).toBe('__Secure-better-auth.session_token=STALE')
    expect(store.getAuthState()!.accountId).toBe('mine')
    expect(gate.halted).toBe(true)
  })

  it('accepts a link for the account it is already bound to', async () => {
    store.putAuthState({ cookie: 'STALE', expiresAt: null, rotatedAt: null, checkedAt: null, accountId: 'mine' })
    const gate = createGate()
    gate.halt('bingers 401')
    const fetchImpl = vi.fn(async (url: any) =>
      String(url).includes('/auth/magic-link/verify')
        ? VERIFIED()
        : new Response(JSON.stringify({ session: { expiresAt: '2027-09-16T08:20:14.792Z' }, user: { id: 'mine' } }), { status: 200 }))
    const { app, auth } = setupApp({ gate, fetchImpl })

    expect((await app.request('/setup', paste(LINK))).status).toBe(200)
    expect(auth.cookieHeader()).toBe('__Secure-better-auth.session_token=FRESH')
    expect(gate.halted).toBe(false)
  })

  // The boot pull returned instantly because there was no session, so the
  // mirror had never synced. Without a pull here, backfill stays suppressed for
  // up to SYNC_PULL_INTERVAL_MIN on a container that was just set up correctly
  // -- and episodes watched in that window never get backfilled at all.
  it('refreshes the mirror immediately, so backfill is not dead for 30 minutes', async () => {
    const { app } = setupApp()
    await app.request('/setup', paste(LINK))
    expect(await (await app.request('/health')).json())
      .toMatchObject({ mirrorFresh: true, backfillEnabled: true, setupRequired: false })
  })

  // A failed first pull is not a failed setup: the session is stored and the
  // next scheduled pull picks it up.
  it('still reports success when that first pull fails', async () => {
    const fetchImpl = vi.fn(async (url: any) => {
      if (String(url).includes('/auth/magic-link/verify')) return VERIFIED()
      if (String(url).includes('/sync/pull')) return new Response('{}', { status: 500 })
      return new Response(JSON.stringify({ session: { expiresAt: '2027-09-16T08:20:14.792Z' } }), { status: 200 })
    })
    const { app, auth } = setupApp({ fetchImpl })
    expect((await app.request('/setup', paste(LINK))).status).toBe(200)
    expect(auth.cookieHeader()).toBe('__Secure-better-auth.session_token=FRESH')
  })
})
