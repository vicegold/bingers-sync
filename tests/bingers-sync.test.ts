import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { pushOps, applyDates, pullOnce } from '../src/bingers/sync.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const mk = (dryRun: boolean, f: any, tol = 120) => ({
  auth: createAuth(store, 'TOK', 'UA'), store, userAgent: 'UA', dryRun,
  watchDateToleranceSec: tol, fetchImpl: f as typeof fetch,
})

const OP = { opId: 'o1', table: 'entries' as const, pk: { entityKind: 'episode' as const, entityId: 'E3' }, fields: { watched: true as const, plays: 1, batchId: null } }

describe('pushOps', () => {
  it('sends nothing at all in dry run', async () => {
    const f = vi.fn()
    expect(await pushOps(mk(true, f), [OP])).toEqual({ dryRun: true })
    expect(f).not.toHaveBeenCalled()
  })

  it('reports the same {dryRun:true} shape in dry run even with no ops to send', async () => {
    const f = vi.fn()
    expect(await pushOps(mk(true, f), [])).toEqual({ dryRun: true })
    expect(f).not.toHaveBeenCalled()
  })

  it('posts one batch with a clientBatchId and the session cookie', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ results: [{ opId: 'o1', status: 'applied' }], rows: {} }), { status: 200 }))
    await pushOps(mk(false, f), [OP])
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('https://api.bingers.app/sync/push')
    expect(init.method).toBe('POST')
    expect(init.headers.Cookie).toBe('__Secure-better-auth.session_token=TOK')
    const body = JSON.parse(init.body)
    expect(body.clientBatchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.ops).toHaveLength(1)
  })

  it('throws on 401 so the caller can halt writing', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(pushOps(mk(false, f), [OP])).rejects.toThrow(/401/)
  })
})

describe('applyDates', () => {
  it('skips the patch when the server stamp is already within tolerance', async () => {
    const serverTime = new Date().toISOString()
    const f = vi.fn(async (url: string) => {
      if (url.includes('/me/watches?')) return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: serverTime }] }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    const n = await applyDates(mk(false, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: serverTime }])
    expect(n).toBe(0)
    expect((f as any).mock.calls.every((c: any[]) => !String(c[1]?.method).includes('PATCH'))).toBe(true)
  })

  it('patches the watch record when the real date differs', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('/me/watches?')) return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: '2026-09-16T10:50:17.841Z' }] }), { status: 200 })
      return new Response(JSON.stringify({ entry: {} }), { status: 200 })
    })
    const n = await applyDates(mk(false, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-11T10:40:47.414Z' }])
    expect(n).toBe(1)
    const patch = (f as any).mock.calls.find((c: any[]) => c[1]?.method === 'PATCH')
    expect(patch[0]).toBe('https://api.bingers.app/me/watches/w1')
    expect(JSON.parse(patch[1].body)).toEqual({
      watchedAt: '2026-09-11T10:40:47.414Z', entityKind: 'episode', entityId: 'E3',
    })
  })

  it('does nothing in dry run', async () => {
    const f = vi.fn()
    expect(await applyDates(mk(true, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-01-01T00:00:00.000Z' }])).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })

  it('selects the newest watch by value, not by array position, for a rewatch with multiple records', async () => {
    // Deliberately non-monotonic order: the middle element is the newest.
    const watches = [
      { id: 'w-old', watchedAt: '2026-01-01T00:00:00.000Z' },
      { id: 'w-newest', watchedAt: '2026-09-16T10:00:00.000Z' },
      { id: 'w-middle', watchedAt: '2026-05-01T00:00:00.000Z' },
    ]
    const f = vi.fn(async (url: string) => {
      if (url.includes('/me/watches?')) return new Response(JSON.stringify({ watches }), { status: 200 })
      return new Response(JSON.stringify({ entry: {} }), { status: 200 })
    })
    const n = await applyDates(mk(false, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-11T10:40:47.414Z' }])
    expect(n).toBe(1)
    const patch = (f as any).mock.calls.find((c: any[]) => c[1]?.method === 'PATCH')
    expect(patch[0]).toBe('https://api.bingers.app/me/watches/w-newest')
  })

  it('skips the patch (does not fail open) when a timestamp is unparseable', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('/me/watches?')) return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: 'not-a-date' }] }), { status: 200 })
      return new Response(JSON.stringify({ entry: {} }), { status: 200 })
    })
    const n = await applyDates(mk(false, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-11T10:40:47.414Z' }])
    expect(n).toBe(0)
    expect((f as any).mock.calls.every((c: any[]) => !String(c[1]?.method).includes('PATCH'))).toBe(true)
  })

  it('throws (does not swallow) a 401 from the GET lookup', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(applyDates(mk(false, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-11T10:40:47.414Z' }])).rejects.toThrow(/401/)
  })

  it('throws (does not swallow) a 401 from the PATCH', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('/me/watches?')) return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: '2026-01-01T00:00:00.000Z' }] }), { status: 200 })
      return new Response('{}', { status: 401 })
    })
    await expect(applyDates(mk(false, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-11T10:40:47.414Z' }])).rejects.toThrow(/401/)
  })

  it('records a failure when a non-401 GET failure leaves a date silently uncorrected', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 500 }))
    const deps = mk(false, f)
    const n = await applyDates(deps, [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-11T10:40:47.414Z' }])
    expect(n).toBe(0)
    const failures = deps.store.listFailures()
    expect(failures.length).toBe(1)
    expect(failures[0].source).toBe('applyDates')
  })

  it('records a failure when a non-401 PATCH failure leaves a date silently uncorrected', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('/me/watches?')) return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: '2026-01-01T00:00:00.000Z' }] }), { status: 200 })
      return new Response('{}', { status: 500 })
    })
    const deps = mk(false, f)
    const n = await applyDates(deps, [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-11T10:40:47.414Z' }])
    expect(n).toBe(0)
    const failures = deps.store.listFailures()
    expect(failures.length).toBe(1)
    expect(failures[0].source).toBe('applyDates')
    expect(failures[0].reason).toMatch(/PATCH \/me\/watches\/w1 -> 500/)
  })
})

describe('pullOnce', () => {
  it('stores follows and entries rows and advances the cursors', async () => {
    const body = {
      follows: [{ titleId: 'T1', kind: 'show', deletedAt: null }],
      entries: [{ entityKind: 'episode', entityId: 'E3', watched: true }],
      cursors: { follows: '2026-09-16T10:00:00.000Z', entries: '2026-09-16T10:00:00.000000Z~episode~E3' },
    }
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    await pullOnce(mk(false, f))
    expect(store.getSyncRow('follows', 'T1')).toMatchObject({ titleId: 'T1' })
    expect(store.getSyncRow('entries', 'episode:E3')).toMatchObject({ entityId: 'E3' })
    expect(store.getCursor('follows')).toBe('2026-09-16T10:00:00.000Z')
  })

  it('sends stored cursors on the next pull', async () => {
    store.setCursor('follows', 'CURSOR1')
    const f = vi.fn(async () => new Response(JSON.stringify({ cursors: {} }), { status: 200 }))
    await pullOnce(mk(false, f))
    expect((f as any).mock.calls[0][0]).toContain('follows=CURSOR1')
  })

  it('does not advance a cursor for a stream it never persists rows for', async () => {
    const body = { cursors: { catalog: 'SHOULD-NOT-STICK', follows: '2026-09-16T10:00:00.000Z' } }
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    await pullOnce(mk(false, f))
    expect(store.getCursor('catalog')).toBeNull()
    expect(store.getCursor('follows')).toBe('2026-09-16T10:00:00.000Z')
  })

  // C1 -- the marker every "is the mirror trustworthy?" check reads.
  it('marks the mirror synced only after a pull actually succeeds', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ cursors: {} }), { status: 200 }))
    expect(store.getMirrorSyncedAt()).toBeNull()
    await pullOnce(mk(false, f))
    expect(store.getMirrorSyncedAt()).not.toBeNull()
  })

  it('leaves the mirror marked stale when the pull fails', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 503 }))
    await expect(pullOnce(mk(false, f))).rejects.toThrow(/503/)
    expect(store.getMirrorSyncedAt()).toBeNull()
  })
})

// An unconfigured container boots with no cookie and sends the user to /setup.
// Until they get there, pulling can only ever 401 -- and a 401 on the boot pull
// writes a failures row and fires the notify webhook, so a container that is
// merely unconfigured reports itself as broken.
describe('pullOnce without a session', () => {
  const noSession = (f: any) => ({
    auth: createAuth(store, '', 'UA'), store, userAgent: 'UA', dryRun: true,
    watchDateToleranceSec: 120, fetchImpl: f as typeof fetch,
  })

  it('does not call bingers at all', async () => {
    const f = vi.fn()
    await pullOnce(noSession(f))
    expect(f).not.toHaveBeenCalled()
  })

  it('does not throw, so boot records no failure and sends no alert', async () => {
    await expect(pullOnce(noSession(vi.fn()))).resolves.toBeUndefined()
  })

  it('leaves the mirror marked stale rather than falsely fresh', async () => {
    await pullOnce(noSession(vi.fn()))
    expect(store.getCursor('__mirror_synced_at')).toBeNull()
  })
})
