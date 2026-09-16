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
const ok = () => vi.fn(async () => new Response(JSON.stringify({ results: [], rows: {} }), { status: 200 }))
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
})
