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

  it('prefers a persisted rotated cookie over the configured one', () => {
    store.putAuthState({ cookie: 'ROTATED', expiresAt: null, rotatedAt: null, checkedAt: null })
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

  it('reports a sliding session when expiresAt moves forward', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })) as any)
    const later = { session: { expiresAt: '2027-09-17T08:20:14.792Z' } }
    const r = await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(later), { status: 200 })) as any)
    expect(r.expiresAt).toBe('2027-09-17T08:20:14.792Z')
  })
})
