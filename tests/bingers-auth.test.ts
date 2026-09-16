import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const SESSION = { session: { expiresAt: '2027-09-16T08:20:14.792Z' }, user: { id: 'u1' } }

describe('createAuth', () => {
  it('builds the cookie header from the configured token', () => {
    const a = createAuth(store, 'TOK', 'UA')
    expect(a.cookieHeader()).toBe('__Secure-better-auth.session_token=TOK')
  })

  // Drives the self-closing /setup gate: with no cookie from either source
  // there is nothing to sync with, and the setup page has to be reachable.
  it('reports no session when neither the store nor the config has a cookie', () => {
    expect(createAuth(store, '', 'UA').hasSession()).toBe(false)
    expect(createAuth(store, 'TOK', 'UA').hasSession()).toBe(true)
  })

  it('reports a session once one has been persisted, even with no configured cookie', () => {
    store.putAuthState({ cookie: 'FROM_SETUP', expiresAt: null, rotatedAt: null, checkedAt: null, accountId: null })
    expect(createAuth(store, '', 'UA').hasSession()).toBe(true)
  })

  it('prefers a persisted rotated cookie over the configured one', () => {
    store.putAuthState({ cookie: 'ROTATED', expiresAt: null, rotatedAt: null, checkedAt: null, accountId: null })
    expect(createAuth(store, 'TOK', 'UA').cookieHeader()).toBe('__Secure-better-auth.session_token=ROTATED')
  })

  it('absorbs a rotated session_token from Set-Cookie and persists it', () => {
    const a = createAuth(store, 'TOK', 'UA')
    const res = new Response('{}', { headers: {
      'set-cookie': '__Secure-better-auth.session_token=NEWTOK; Max-Age=31536000; Path=/; Secure' } })
    a.absorb(res)
    expect(a.cookieHeader()).toBe('__Secure-better-auth.session_token=NEWTOK')
    expect(store.getAuthState()!.cookie).toBe('NEWTOK')
    expect(store.getAuthState()!.rotatedAt).not.toBeNull()
  })

  it('ignores the 5-minute session_data cache cookie', () => {
    const a = createAuth(store, 'TOK', 'UA')
    a.absorb(new Response('{}', { headers: { 'set-cookie': '__Secure-better-auth.session_data=abc; Max-Age=300' } }))
    expect(a.cookieHeader()).toBe('__Secure-better-auth.session_token=TOK')
  })

  it('records expiresAt from the heartbeat', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 }))
    const a = createAuth(store, 'TOK', 'UA')
    const r = await a.heartbeat(f as any)
    expect(r.expiresAt).toBe('2027-09-16T08:20:14.792Z')
    expect(store.getAuthState()!.expiresAt).toBe('2027-09-16T08:20:14.792Z')
    expect((f as any).mock.calls[0][0]).toContain('/auth/get-session?disableCookieCache=true')
  })

  it('absorbs a rotated session_token even when the heartbeat response is not ok', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    const f = vi.fn(async () => new Response('{}', {
      status: 401,
      headers: { 'set-cookie': '__Secure-better-auth.session_token=ROTATED_ON_FAIL; Max-Age=31536000; Path=/; Secure' },
    }))
    await expect(a.heartbeat(f as any)).rejects.toThrow(/401/)
    expect(a.cookieHeader()).toBe('__Secure-better-auth.session_token=ROTATED_ON_FAIL')
    expect(store.getAuthState()!.cookie).toBe('ROTATED_ON_FAIL')
  })

  // The seed in the environment exists for a database that has never been set
  // up. A row with an empty cookie is not a session, and `??` let it shadow the
  // seed, so the documented escape hatch quietly did nothing.
  it('does not let a persisted empty cookie shadow the configured one', () => {
    store.putAuthState({ cookie: '', expiresAt: null, rotatedAt: null, checkedAt: null, accountId: null })
    expect(createAuth(store, 'SEED', 'UA').cookieHeader()).toBe('__Secure-better-auth.session_token=SEED')
  })

  it('records the account the session belongs to', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    const r = await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })) as any)
    expect(r.accountId).toBe('u1')
    expect(a.accountId()).toBe('u1')
  })

  // A response without `user` must not erase the account this container is
  // bound to -- that binding is the only thing that refuses someone else's link.
  it('keeps the bound account when a heartbeat response omits the user', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })) as any)
    await a.heartbeat(vi.fn(async () =>
      new Response(JSON.stringify({ session: { expiresAt: '2027-10-01T00:00:00Z' } }), { status: 200 })) as any)
    expect(a.accountId()).toBe('u1')
  })
})

// A session can stop working two ways, and the write gate saw neither of them:
// it only ever closes on a 401 from a real WRITE, which under DRY_RUN never
// reaches the network at all. /setup keys off this instead.
describe('sessionDead', () => {
  it('is false for a healthy session and for no session at all', () => {
    expect(createAuth(store, '', 'UA').sessionDead()).toBe(false)
    expect(createAuth(store, 'TOK', 'UA').sessionDead()).toBe(false)
  })

  it('is true once expiresAt has passed', () => {
    store.putAuthState({ cookie: 'TOK', expiresAt: '2020-01-01T00:00:00Z', rotatedAt: null, checkedAt: null, accountId: null })
    expect(createAuth(store, '', 'UA').sessionDead()).toBe(true)
  })

  // The 401 that matters most comes from a READ (pull, heartbeat), which never
  // halts the write gate -- so before this the page could not reopen for it.
  it('is true once an authenticated call has come back 401', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    a.noteUnauthorized()
    expect(a.sessionDead()).toBe(true)
  })

  it('clears once a cookie that works replaces the one that did not', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    a.noteUnauthorized()
    a.absorb(new Response('{}', { headers: {
      'set-cookie': '__Secure-better-auth.session_token=FRESH; Max-Age=31536000' } }))
    expect(a.sessionDead()).toBe(false)
  })

  it('clears on a heartbeat that succeeds', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    a.noteUnauthorized()
    await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })) as any)
    expect(a.sessionDead()).toBe(false)
  })

  it('is set by a 401 heartbeat, which is how a restart re-learns it', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    await expect(a.heartbeat(vi.fn(async () => new Response('{}', { status: 401 })) as any)).rejects.toThrow(/401/)
    expect(a.sessionDead()).toBe(true)
  })
})

describe('snapshot/restore', () => {
  // /setup adopts a cookie before it knows whether the session works or whose
  // it is. Both checks can reject it, and a rejected link must leave the
  // container on the session it already had.
  it('puts back the cookie and the persisted state a failed setup replaced', async () => {
    store.putAuthState({ cookie: 'OLD', expiresAt: '2027-01-01T00:00:00Z', rotatedAt: null, checkedAt: null, accountId: 'u1' })
    const a = createAuth(store, '', 'UA')
    const before = a.snapshot()
    a.absorb(new Response('{}', { headers: {
      'set-cookie': '__Secure-better-auth.session_token=INTRUDER; Max-Age=31536000' } }))
    expect(a.cookieHeader()).toContain('INTRUDER')
    a.restore(before)
    expect(a.cookieHeader()).toBe('__Secure-better-auth.session_token=OLD')
    expect(store.getAuthState()).toMatchObject({ cookie: 'OLD', accountId: 'u1', expiresAt: '2027-01-01T00:00:00Z' })
  })
})

describe('createAuth (continued)', () => {
  it('reports a sliding session when expiresAt moves forward', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })) as any)
    const later = { session: { expiresAt: '2027-09-17T08:20:14.792Z' } }
    const r = await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(later), { status: 200 })) as any)
    expect(r.expiresAt).toBe('2027-09-17T08:20:14.792Z')
  })
})
