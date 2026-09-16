// tests/outbox.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { createGate, submit, flushOutbox, backoffMs } from '../src/outbox.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const OP = (id: string) => ({
  opId: id, table: 'entries' as const,
  pk: { entityKind: 'episode' as const, entityId: 'E' + id },
  fields: { watched: true as const, plays: 1, batchId: null },
})
const mk = (f: any) => ({
  auth: createAuth(store, 'TOK', 'UA'), store, userAgent: 'UA',
  dryRun: false, watchDateToleranceSec: 120, fetchImpl: f as typeof fetch,
})
const mkDry = (f: any) => ({ ...mk(f), dryRun: true })
// Body-aware: reports every op in the request as server-applied, so tests
// that assert a full drain stay correct under the strict appliedIds-only
// bookkeeping in flushOutbox (a partial-rejection response is stubbed
// explicitly where that behavior is under test).
const ok = () => vi.fn(async (_url: string, init?: any) => {
  const ops = init?.body ? JSON.parse(init.body).ops : []
  const results = ops.map((o: any) => ({ opId: o.opId, status: 'applied' }))
  return new Response(JSON.stringify({ results, rows: {} }), { status: 200 })
})
const boom = (status: number) => vi.fn(async () => new Response('{}', { status }))

describe('backoffMs', () => {
  it('grows exponentially and caps at an hour', () => {
    expect(backoffMs(0)).toBe(60_000)
    expect(backoffMs(3)).toBe(480_000)
    expect(backoffMs(99)).toBe(3_600_000)
  })
})

describe('submit', () => {
  it('sends when healthy and queues nothing', async () => {
    const r = await submit(mk(ok()), createGate(), [OP('1')])
    expect(r).toBe('sent')
    expect(store.outboxDepth()).toBe(0)
  })

  it('queues the ops when bingers returns 500', async () => {
    const r = await submit(mk(boom(500)), createGate(), [OP('1')])
    expect(r).toBe('queued')
    expect(store.outboxDepth()).toBe(1)
  })

  it('halts the gate on 401 and still queues rather than dropping work', async () => {
    const gate = createGate()
    const r = await submit(mk(boom(401)), gate, [OP('1')])
    expect(r).toBe('halted')
    expect(gate.halted).toBe(true)
    expect(store.outboxDepth()).toBe(1)
  })

  it('queues without sending once halted', async () => {
    const gate = createGate(); gate.halt('401')
    const f = ok()
    expect(await submit(mk(f), gate, [OP('2')])).toBe('halted')
    expect(f).not.toHaveBeenCalled()
    expect(store.outboxDepth()).toBe(1)
  })
})

describe('flushOutbox', () => {
  it('drains queued ops once bingers recovers', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1'), OP('2')])
    expect(store.outboxDepth()).toBe(2)
    const n = await flushOutbox(mk(ok()), createGate())
    expect(n).toBe(2)
    expect(store.outboxDepth()).toBe(0)
  })

  it('does nothing while the gate is halted', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1')])
    const gate = createGate(); gate.halt('401')
    const f = ok()
    expect(await flushOutbox(mk(f), gate)).toBe(0)
    expect(f).not.toHaveBeenCalled()
    expect(store.outboxDepth()).toBe(1)
  })

  it('reschedules rather than dropping when the retry also fails', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1')])
    const n = await flushOutbox(mk(boom(503)), createGate())
    expect(n).toBe(0)
    expect(store.outboxDepth()).toBe(1)
  })

  it('marks only server-confirmed ops applied and reschedules a rejected op inside an otherwise-200 batch, rather than losing it', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1'), OP('2')])
    expect(store.outboxDepth()).toBe(2)
    const partial = vi.fn(async () => new Response(JSON.stringify({
      results: [{ opId: '1', status: 'applied' }, { opId: '2', status: 'rejected' }],
      rows: {},
    }), { status: 200 }))
    const n = await flushOutbox(mk(partial), createGate())
    expect(n).toBe(1)
    expect(store.outboxDepth()).toBe(1)
  })

  it('does not drain the outbox under dry run: ops queued while live must survive a restart into DRY_RUN=true', async () => {
    // Reachable sequence: run live, queue ops during an outage or a halted
    // session (SQLite-backed, survives restart), then restart with
    // DRY_RUN=true (the project default). flushOutbox must not treat
    // pushOps's `{ dryRun: true }` no-op as a successful send.
    await submit(mk(boom(500)), createGate(), [OP('1'), OP('2')])
    expect(store.outboxDepth()).toBe(2)
    const f = ok()
    const n = await flushOutbox(mkDry(f), createGate())
    expect(n).toBe(0)
    expect(store.outboxDepth()).toBe(2)
    expect(f).not.toHaveBeenCalled()
  })
})

// I2 -- submit is the path EVERY webhook takes; flushOutbox only ever sees ops
// that already failed once. A 200 whose per-op results reject an entry used to
// return 'sent' and drop the work entirely.
describe('submit honours the per-op results of a 200', () => {
  it('reports queued rather than sent when the server confirmed nothing', async () => {
    const none = vi.fn(async () => new Response(JSON.stringify({ results: [], rows: {} }), { status: 200 }))
    const r = await submit(mk(none), createGate(), [OP('1')])
    expect(r).toBe('queued')
    expect(store.outboxDepth()).toBe(1)
    expect(store.listFailures().some(x => /confirmed 0\/1/.test(x.reason))).toBe(true)
  })

  it('re-queues only the unconfirmed op of a partially applied batch', async () => {
    const partial = vi.fn(async (_url: string, init?: any) => {
      const ops = JSON.parse(init.body).ops
      return new Response(JSON.stringify({
        results: [{ opId: ops[0].opId, status: 'applied' }, { opId: ops[1].opId, status: 'rejected' }], rows: {},
      }), { status: 200 })
    })
    const r = await submit(mk(partial), createGate(), [OP('1'), OP('2')])
    expect(r).toBe('partial')
    expect(store.outboxDepth()).toBe(1)
    expect(store.dueOps(new Date().toISOString())[0]?.opId).toBe('2')
    expect(store.listFailures().some(x => /confirmed 1\/2/.test(x.reason))).toBe(true)
  })

  it('does not queue anything under dry run, where nothing was attempted', async () => {
    const f = ok()
    expect(await submit(mkDry(f), createGate(), [OP('1')])).toBe('sent')
    expect(store.outboxDepth()).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })
})

// I3 -- plan.dated used to live only in memory, so anything that went through
// the outbox landed stamped with flush time instead of its real Plex time.
describe('date corrections survive the outbox', () => {
  const DATED = [{ entityKind: 'episode' as const, entityId: 'E1', watchedAt: '2026-08-29T10:40:00.000Z' }]

  const datedServer = () => {
    const calls: { url: string; init?: any }[] = []
    const f = vi.fn(async (url: string, init?: any) => {
      calls.push({ url, init })
      if (url.includes('/sync/push')) {
        const ops = JSON.parse(init.body).ops
        return new Response(JSON.stringify({ results: ops.map((o: any) => ({ opId: o.opId, status: 'applied' })), rows: {} }), { status: 200 })
      }
      if (url.includes('/me/watches?')) {
        // Server stamped it at push time, days after the real watch.
        return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: '2026-09-16T12:00:00.000Z' }] }), { status: 200 })
      }
      return new Response(JSON.stringify({ entry: {} }), { status: 200 })
    })
    return { f, calls }
  }

  it('patches a flushed op to its persisted plex watch time, not to the flush time', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1')], DATED)
    expect(store.outboxDepth()).toBe(1)

    const { f, calls } = datedServer()
    expect(await flushOutbox(mk(f), createGate())).toBe(1)
    const patch = calls.find(c => c.init?.method === 'PATCH')
    expect(patch).toBeDefined()
    expect(JSON.parse(patch!.init.body).watchedAt).toBe('2026-08-29T10:40:00.000Z')
  })

  it('corrects dates on the primary submit path too', async () => {
    const { f, calls } = datedServer()
    expect(await submit(mk(f), createGate(), [OP('1')], DATED)).toBe('sent')
    const patch = calls.find(c => c.init?.method === 'PATCH')
    expect(JSON.parse(patch!.init.body).watchedAt).toBe('2026-08-29T10:40:00.000Z')
  })

  it('does not correct the date of an op the server refused', async () => {
    const calls: { url: string; init?: any }[] = []
    const f = vi.fn(async (url: string, init?: any) => {
      calls.push({ url, init })
      if (url.includes('/sync/push')) return new Response(JSON.stringify({ results: [], rows: {} }), { status: 200 })
      return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: '2026-09-16T12:00:00.000Z' }] }), { status: 200 })
    })
    await submit(mk(f), createGate(), [OP('1')], DATED)
    expect(calls.some(c => c.url.includes('/me/watches'))).toBe(false)
  })
})

// I4 -- the spec's failure table: "Bingers 401 -> stop writing, keep queueing,
// notify". A 401 raised by applyDates used to escape unwrapped, leaving the
// gate OPEN, and no halt anywhere ever notified.
describe('gate halts are notified, whichever call saw the 401', () => {
  const withGlobalFetch = async (fn: (posted: { url: string }[]) => Promise<void>) => {
    const posted: { url: string }[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: string) => { posted.push({ url: String(url) }); return new Response('{}', { status: 200 }) }))
    try { await fn(posted) } finally { vi.unstubAllGlobals() }
  }

  it('notifies when a 401 from sync/push halts the gate', async () => {
    await withGlobalFetch(async posted => {
      const gate = createGate()
      expect(await submit({ ...mk(boom(401)), notifyUrl: 'http://hook' }, gate, [OP('1')])).toBe('halted')
      expect(gate.halted).toBe(true)
      expect(posted.some(p => p.url === 'http://hook')).toBe(true)
    })
    expect(store.listFailures().some(x => x.source === 'gate')).toBe(true)
    expect(store.outboxDepth()).toBe(1)
  })

  it('halts the gate and notifies when date correction gets a 401 after a successful push', async () => {
    const f = vi.fn(async (url: string, init?: any) => {
      if (url.includes('/sync/push')) {
        const ops = JSON.parse(init.body).ops
        return new Response(JSON.stringify({ results: ops.map((o: any) => ({ opId: o.opId, status: 'applied' })), rows: {} }), { status: 200 })
      }
      return new Response('{}', { status: 401 })
    })
    const gate = createGate()
    await withGlobalFetch(async posted => {
      await submit({ ...mk(f), notifyUrl: 'http://hook' }, gate,
        [OP('1')], [{ entityKind: 'episode', entityId: 'E1', watchedAt: '2026-08-29T10:40:00.000Z' }])
      expect(posted.some(p => p.url === 'http://hook')).toBe(true)
    })
    expect(gate.halted).toBe(true)
    expect(gate.reason).toMatch(/401/)
    // and the un-corrected dates are recorded so they can be replayed by hand
    expect(store.listFailures().some(x => x.source === 'applyDates' && x.payload.includes('2026-08-29T10:40:00.000Z'))).toBe(true)
  })

  it('notifies when a 401 during a flush halts the gate', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1')])
    const gate = createGate()
    await withGlobalFetch(async posted => {
      await flushOutbox({ ...mk(boom(401)), notifyUrl: 'http://hook' }, gate)
      expect(posted.some(p => p.url === 'http://hook')).toBe(true)
    })
    expect(gate.halted).toBe(true)
    expect(store.outboxDepth()).toBe(1)
  })
})

// Binge behaviour: the mirror otherwise only refreshes every 30 minutes.
describe('optimistic local mirror', () => {
  it('records a confirmed entries write in sync_state immediately', async () => {
    await submit(mk(ok()), createGate(), [OP('1')])
    expect(store.getSyncRow('entries', 'episode:E1')).toMatchObject({ watched: true, deletedAt: null })
  })

  it('records nothing for an op the server did not confirm', async () => {
    const none = vi.fn(async () => new Response(JSON.stringify({ results: [], rows: {} }), { status: 200 }))
    await submit(mk(none), createGate(), [OP('1')])
    expect(store.getSyncRow('entries', 'episode:E1')).toBeNull()
  })

  it('records nothing under dry run', async () => {
    await submit(mkDry(ok()), createGate(), [OP('1')])
    expect(store.getSyncRow('entries', 'episode:E1')).toBeNull()
  })
})

describe('enqueueOps / dueOps round-trip', () => {
  it('preserves the delete-op shape: no spurious fields key is added', () => {
    const del = { opId: 'd1', table: 'follows' as const, pk: { titleId: 'T1' }, deleted: true as const }
    store.enqueueOps([del] as any)
    const [rt] = store.dueOps(new Date().toISOString())
    expect(rt).toEqual(del)
    expect(rt.deleted).toBe(true)
    expect('fields' in rt).toBe(false)
  })
})
