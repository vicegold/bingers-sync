import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { loadConfig } from '../src/config.js'
import { createApp, boot } from '../src/server.js'
import { serve } from '@hono/node-server'
import type { AddressInfo } from 'node:net'
import { createGate, flushOutbox, MAX_OP_REJECTIONS } from '../src/outbox.js'
import { syncRatingsToPlex } from '../src/ratings/toPlex.js'

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
  // otherwise re-authenticating means editing compose and restarting again.
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

// RRR2. An abandoned op is a user write this service has decided to stop
// trying to deliver -- the single most important thing here not to lose
// silently. The cap is global: this is a plain watched op, not a rating.
describe('abandoned ops are visible on /health', () => {
  it('reports zero while nothing has been abandoned', async () => {
    const b = await (await app().request('/health')).json() as Record<string, unknown>
    expect(b).toHaveProperty('abandonedOps', 0)
  })

  it('reports a non-zero count once an op has been abandoned', async () => {
    const op = {
      opId: 'w1', table: 'entries' as const,
      pk: { entityKind: 'episode' as const, entityId: 'E1' },
      fields: { watched: true as const, plays: 1, batchId: null },
    }
    store.enqueueOps([op])
    // A 200 whose `results` confirm nothing: bingers answered and refused.
    const fetchImpl = vi.fn(async () =>
      new Response(JSON.stringify({ results: [], rows: {} }), { status: 200 })) as any
    const sd = {
      auth: createAuth(store, 'TOK', 'UA'), store, userAgent: 'UA',
      dryRun: false, watchDateToleranceSec: 120, fetchImpl,
    }
    const gate = createGate()
    for (let i = 0; i < MAX_OP_REJECTIONS; i++) {
      store.reschedule('w1', new Date(0).toISOString())
      await flushOutbox(sd, gate)
    }

    const b = await (await app().request('/health')).json() as Record<string, unknown>
    expect(b).toHaveProperty('abandonedOps', 1)
    expect(b).toHaveProperty('outboxDepth', 0)
  })
})

describe('reverse sync health', () => {
  it('reports reverse sync state on /health', async () => {
    const res = await app().request('/health')
    const b = await res.json() as Record<string, unknown>
    expect(b).toHaveProperty('reverseSync')
    expect(b).toHaveProperty('watchlistLinked', 0)
  })
})

describe('rating sync health', () => {
  it('reports rating sync state on /health', async () => {
    const res = await app().request('/health')
    const b = await res.json() as Record<string, unknown>
    expect(b).toHaveProperty('ratingSync')
    expect(b).toHaveProperty('ratingsLinked', 0)
    expect(b).toHaveProperty('lastRatingRun', null)
  })

  // Step 1 only checks the keys exist, which would pass against a /health that
  // reports zeroes forever. `refusedHalfStar` is the half-star safety guard
  // actively declining a write -- the EVENT, reported separately from layer
  // 1's steady state, which is the whole point of splitting them -- so this drives
  // a REAL syncRatingsToPlex run against a fixture that must be refused (plex's
  // live value is 9, an odd/half-star rating; bingers holds the rounded 5;
  // writing back bingersToPlex(5)=10 would destroy the half-star) and confirms
  // /health surfaces that true count once lastRatingRun carries the result.
  it('surfaces a real refused-write count from an actual rating run on /health', async () => {
    store.putSyncRows('entries', [{ pk: 'movie:M1', row: { entityKind: 'movie', entityId: 'M1', rating: 5, watched: true, deletedAt: null } }])
    store.putTitleMapping([{ source: 'tmdb', extId: '467244', kind: 'movie', titleId: 'M1', title: 'The Zone of Interest', year: 2023 }])
    const routes: [RegExp, unknown][] = [
      [/library\/sections$/, { MediaContainer: { Directory: [{ key: '2', type: 'movie', title: 'Filme' }] } }],
      [/sections\/2\/all/, { MediaContainer: { Metadata: [
        { ratingKey: '46807', type: 'movie', title: 'The Zone of Interest', userRating: 9, Guid: [{ id: 'tmdb://467244' }] },
      ] } }],
      [/:\/rate/, {}],
    ]
    const fetchImpl = vi.fn(async (url: string) => {
      for (const [re, body] of routes) if (re.test(url)) return new Response(JSON.stringify(body), { status: 200 })
      return new Response('{}', { status: 404 })
    }) as any
    const auth = createAuth(store, 'TOK', 'UA')
    const gate = createGate()
    const toPlex = await syncRatingsToPlex({ config: CONFIG, store, auth, gate, fetchImpl })
    // Sanity check on the fixture itself, not the wiring under test.
    expect(toPlex.refusedHalfStar).toBe(1)
    expect(toPlex.refusedOrigin).toBe(0)
    expect(toPlex.written).toBe(0)

    const deps = {
      config: CONFIG, store, auth, gate, fetchImpl,
      lastRatingRun: () => ({
        at: new Date().toISOString(),
        fromPlex: { synced: 0, unsupported: 0, unresolved: 0, ignored: 0, failed: 0 },
        toPlex,
      }),
    }
    const res = await createApp(deps).request('/health')
    const b = await res.json() as any
    // Reported SEPARATELY on /health: a steady-state layer 1 refusal and a
    // half-star save must not be one indistinguishable number there.
    expect(b.lastRatingRun.toPlex.refusedHalfStar).toBe(1)
    expect(b.lastRatingRun.toPlex.refusedOrigin).toBe(0)
    expect(b.lastRatingRun.toPlex.written).toBe(0)
  })
})

// I3: pull(), beat() and reverse() all await third-party hosts, and reverse()
// is up to REVERSE_BATCH x 7 sequential plex discover requests. Awaiting any of
// them before the listener opens means that while a third party is merely slow,
// the port is CLOSED -- every Plex media.scrobble gets connection-refused
// instead of the 200 the forward path depends on, and Plex never replays them.
describe('boot order', () => {
  it('serves /health within a second of start, with the boot reconcile still hung', async () => {
    const never = () => new Promise<void>(() => { /* a discover host that never answers */ })
    let server: ReturnType<typeof serve> | undefined
    let port = 0
    const listening = new Promise<void>(resolve => {
      void boot({
        listen: () => { server = serve({ fetch: app().fetch, port: 0 }, (info: AddressInfo) => { port = info.port; resolve() }) },
        pull: never, beat: never, reverse: never, ratings: never, flush: never,
        pullIntervalMin: 30,
        schedule: () => { /* no real intervals in a test */ },
      })
    })

    try {
      await Promise.race([
        listening,
        new Promise((_r, rej) => setTimeout(() => rej(new Error('listener did not open within 1s')), 1000)),
      ])
      const res = await fetch(`http://127.0.0.1:${port}/health`)
      expect(res.status).toBe(200)
      expect(await res.json()).toMatchObject({ ok: true })
    } finally {
      server?.close()
    }
  })

  it('registers the recurring timers before awaiting the boot reconcile', async () => {
    const never = () => new Promise<void>(() => {})
    const scheduled: number[] = []
    void boot({
      listen: () => {}, pull: never, beat: never, reverse: never, ratings: never, flush: never,
      pullIntervalMin: 30, schedule: (_fn, ms) => { scheduled.push(ms) },
    })
    await Promise.resolve()
    expect(scheduled).toEqual([30 * 60_000, 24 * 60 * 60_000, 60_000])
  })

  // Finding 13, re-flagged: the pull -> reverse -> ratings chain is sequential
  // and unbounded, and ratings alone can outlast a 30-minute interval on a
  // large library. Two overlapping chains interleave outbox writes and
  // sync_state mirrors for the same entities -- the half-updated local state
  // RR1's transaction exists to prevent, arriving through a second door.
  it('skips a scheduled cycle while the previous one is still running', async () => {
    const settled = () => new Promise(r => setImmediate(r))
    let release!: () => void
    const held = new Promise<void>(r => { release = r })
    let blocking = false
    const pulls: number[] = []
    const pull = async () => { pulls.push(pulls.length); if (blocking) await held }
    const noop = async () => {}
    let tick!: () => void
    void boot({
      listen: () => {}, pull, beat: noop, reverse: noop, ratings: noop, flush: noop,
      pullIntervalMin: 30,
      schedule: (fn, ms) => { if (ms === 30 * 60_000) tick = fn },
    })
    await settled()
    // boot's own reconcile pull already ran and completed (blocking was false).
    expect(pulls).toHaveLength(1)

    blocking = true
    tick(); await settled()
    expect(pulls).toHaveLength(2) // cycle 1 started, now parked on `held`
    tick(); await settled()
    expect(pulls).toHaveLength(2) // cycle 2 SKIPPED, not queued

    release(); await settled()
    tick(); await settled()
    expect(pulls).toHaveLength(3) // the flag cleared, so ticks work again
  })
})
