// tests/outbox.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { createGate, submit, flushOutbox, backoffMs, MAX_OP_REJECTIONS } from '../src/outbox.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const OP = (id: string) => ({
  opId: id, table: 'entries' as const,
  pk: { entityKind: 'episode' as const, entityId: 'E' + id },
  fields: { watched: true as const, plays: 1, batchId: null },
})
const RATING_OP = (id: string, entityId: string, rating: number) => ({
  opId: id, table: 'entries' as const,
  pk: { entityKind: 'episode' as const, entityId },
  fields: { rating },
})
const WATCHED_OP = (id: string, entityId: string, plays: number) => ({
  opId: id, table: 'entries' as const,
  pk: { entityKind: 'episode' as const, entityId },
  fields: { watched: true as const, plays, batchId: null },
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
  // The no-session guard was added to pullOnce and the heartbeat but not here,
  // so an unconfigured container sent `Cookie: ...=` with an empty value, got a
  // 401, and halted the gate + fired the notify webhook -- announcing itself as
  // broken for the one reason that is not a fault. The work must queue instead.
  it('queues without halting or notifying when there is no session yet', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 401 }))
    const deps = { ...mk(f), auth: createAuth(store, '', 'UA'), notifyUrl: 'http://hook' }
    const gate = createGate()
    const r = await submit(deps, gate, [OP('1')])
    expect(r).toBe('queued')
    expect(gate.halted).toBe(false)
    expect(store.outboxDepth()).toBe(1)
    expect(f).not.toHaveBeenCalled()
    expect(store.listFailures(10)).toHaveLength(0)
  })

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

  // RRR1. submit()'s transaction was entirely untested -- removing it left
  // every other test green -- on shared forward-path code. The property it
  // actually provides is NOT "the rejected ops are safe" (they are gone either
  // way; the throw happened while queueing them). It is that the APPLIED half
  // is discarded too, so local state records none of the response rather than
  // half of it -- and "none" is re-derivable from the next pull, while "half"
  // is a mirror asserting a write landed, which is exactly what stops the
  // forward path ever revisiting it.
  it('discards the mirror too when queueing the rejected half throws, recording none of the response', async () => {
    const partial = vi.fn(async (_url: string, init?: any) => {
      const ops = JSON.parse(init.body).ops
      return new Response(JSON.stringify({
        results: [{ opId: ops[0].opId, status: 'applied' }, { opId: ops[1].opId, status: 'rejected' }], rows: {},
      }), { status: 200 })
    })
    const deps = { ...mk(partial), store: { ...store, enqueueOps: () => { throw new Error('disk full') } } }
    await expect(submit(deps as any, createGate(), [OP('1'), OP('2')])).rejects.toThrow('disk full')

    // Neither half is visible: not the applied op's mirror, not the rejected
    // op's outbox row, not the failure row that describes the split.
    expect(store.getSyncRow('entries', 'episode:E1')).toBeNull()
    expect(store.outboxDepth()).toBe(0)
    expect(store.listFailures().some(x => /confirmed 1\/2/.test(x.reason))).toBe(false)

    // And that state is the RECOVERABLE one: local state makes no claim about
    // E1 at all, so the next sync/pull -- which is putSyncRows, exactly this --
    // learns it from the server rather than being told it is already done.
    store.putSyncRows('entries', [{ pk: 'episode:E1', row: { entityKind: 'episode', entityId: 'E1', watched: true, plays: 1, deletedAt: null } }])
    expect(store.getSyncRow('entries', 'episode:E1')).toMatchObject({ watched: true })
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
  // notify() uses deps.fetchImpl (see src/notify.ts / src/outbox.ts haltGate),
  // so the notification lands on the SAME mock used for the API calls rather
  // than the global fetch -- the hook url is picked out of that mock's calls.
  const postedTo = (f: any) => (f as any).mock.calls.some((c: any[]) => c[0] === 'http://hook')

  it('notifies when a 401 from sync/push halts the gate', async () => {
    const f = boom(401)
    const gate = createGate()
    expect(await submit({ ...mk(f), notifyUrl: 'http://hook' }, gate, [OP('1')])).toBe('halted')
    expect(gate.halted).toBe(true)
    expect(postedTo(f)).toBe(true)
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
    await submit({ ...mk(f), notifyUrl: 'http://hook' }, gate,
      [OP('1')], [{ entityKind: 'episode', entityId: 'E1', watchedAt: '2026-08-29T10:40:00.000Z' }])
    expect(postedTo(f)).toBe(true)
    expect(gate.halted).toBe(true)
    expect(gate.reason).toMatch(/401/)
    // and the un-corrected dates are recorded so they can be replayed by hand
    expect(store.listFailures().some(x => x.source === 'applyDates' && x.payload.includes('2026-08-29T10:40:00.000Z'))).toBe(true)
  })

  it('notifies when a 401 during a flush halts the gate', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1')])
    const gate = createGate()
    const f = boom(401)
    await flushOutbox({ ...mk(f), notifyUrl: 'http://hook' }, gate)
    expect(postedTo(f)).toBe(true)
    expect(gate.halted).toBe(true)
    expect(store.outboxDepth()).toBe(1)
  })
})

// Binge behaviour: the mirror otherwise only refreshes every 30 minutes.
// RR1. markApplied and mirrorApplied describe ONE event, and ran in separate
// transactions with the reschedule loop between them. A crash in that gap left
// the op no longer `pending` while sync_state still held the PRE-push value --
// a rating src/ratings/toPlex.ts then reads as a deliberate bingers-side change
// and writes back over the plex value it came from.
describe('flushOutbox marks and mirrors atomically (RR1)', () => {
  it('rolls the applied-mark back when the mirror write fails, rather than leaving half-updated state', async () => {
    store.enqueueOps([RATING_OP('r1', 'E1', 4)])
    expect(store.outboxDepth()).toBe(1)
    // The mirror's own write fails partway through the pair. `tx` is the real
    // store method, so only putSyncRows is broken -- exactly the shape of a
    // crash between the two.
    const deps = { ...mk(ok()), store: { ...store, putSyncRows: () => { throw new Error('disk full') } } }
    await flushOutbox(deps as any, createGate())

    // Neither half may have landed. Applied-but-unmirrored is the dangerous
    // state: hasPendingRatingOp would go false over a stale mirror.
    expect(store.outboxDepth()).toBe(1)
    expect(store.getSyncRow('entries', 'episode:E1')).toBeNull()
    expect(store.hasPendingRatingOp('episode', 'E1')).toBe(true)
  })
})

// RR3. flushOutbox had no cap, so an op bingers permanently rejects stayed
// `pending` forever. Since Layer 1 consults hasPendingRatingOp(), that is a
// PERMANENT LOCKOUT of the entity from the bingers->plex direction, not merely
// wasted work.
describe('an op bingers keeps rejecting is abandoned, not retried forever (RR3)', () => {
  // A 200 whose `results` confirm nothing: the server answered and refused.
  const rejectsEverything = () => vi.fn(async () =>
    new Response(JSON.stringify({ results: [], rows: {} }), { status: 200 }))
  const makeDue = (opId: string) => store.reschedule(opId, new Date(0).toISOString())

  it('moves it to a terminal status past the cap and records a failure naming it', async () => {
    store.enqueueOps([RATING_OP('r1', 'E1', 4)])
    const deps = mk(rejectsEverything())
    const gate = createGate()
    for (let i = 0; i < MAX_OP_REJECTIONS; i++) { makeDue('r1'); await flushOutbox(deps, gate) }

    expect(store.outboxDepth()).toBe(0)
    expect(store.abandonedDepth()).toBe(1) // terminal, NOT deleted: still inspectable
    const failure = store.listFailures().find(x => /abandoned after/.test(x.reason))
    expect(failure).toBeDefined()
    expect(failure!.reason).toContain('r1')
    expect(JSON.parse(failure!.payload)).toMatchObject({ opId: 'r1', pk: { entityId: 'E1' } })
  })

  it('releases the entity lockout that kept a genuine bingers rating from reaching plex', async () => {
    store.enqueueOps([RATING_OP('r1', 'E1', 4)])
    expect(store.hasPendingRatingOp('episode', 'E1')).toBe(true)
    const deps = mk(rejectsEverything())
    const gate = createGate()
    for (let i = 0; i < MAX_OP_REJECTIONS; i++) { makeDue('r1'); await flushOutbox(deps, gate) }
    expect(store.hasPendingRatingOp('episode', 'E1')).toBe(false)
  })

  // The budget is spent by REJECTIONS, not by `attempts`, which also ticks for
  // transport failures. Counting the shared `attempts` column would let a long
  // outage exhaust the budget, so the FIRST time bingers actually answered and
  // refused the op it would be abandoned on the spot -- discarding a write
  // that was never shown to be unacceptable.
  it('does not let an outage spend the budget: a first real rejection after many transport failures still retries', async () => {
    store.enqueueOps([RATING_OP('r1', 'E1', 4)])
    const gate = createGate()
    for (let i = 0; i < MAX_OP_REJECTIONS + 2; i++) { makeDue('r1'); await flushOutbox(mk(boom(500)), gate) }
    // The outage alone abandons nothing, and has run `attempts` well past the cap.
    expect(store.outboxDepth()).toBe(1)
    expect(store.abandonedDepth()).toBe(0)
    expect(store.attemptsFor('r1')).toBeGreaterThanOrEqual(MAX_OP_REJECTIONS)

    // Bingers comes back and refuses it ONCE. One refusal is not a pattern.
    makeDue('r1')
    await flushOutbox(mk(rejectsEverything()), gate)
    expect(store.outboxDepth()).toBe(1)
    expect(store.abandonedDepth()).toBe(0)
    expect(store.listFailures().some(x => /abandoned after/.test(x.reason))).toBe(false)
  })
})

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

  // The other half of the reverse-sync round trip: when the forward path
  // unfollows a title (pulsarr saw it leave the plex watchlist), the mirrored
  // delete must also drop the plex_link, or re-following the title later leaves
  // it permanently invisible to the reverse queue.
  it('drops the plex_link when a confirmed unfollow is mirrored', async () => {
    store.putPlexLink({ titleId: 'T1', ratingKey: 'k', state: 'added', attempts: 0, nextTryAt: null })
    const del = { opId: 'd1', table: 'follows' as const, pk: { titleId: 'T1' }, deleted: true as const }
    await submit(mk(ok()), createGate(), [del] as any)
    expect(store.getSyncRow('follows', 'T1')).toMatchObject({ titleId: 'T1' })
    expect(store.getPlexLink('T1')).toBeNull()
  })

  // Fix round 1: a rating-only entries op must never invent a watched flag.
  it('a rating-only push with no prior mirror row leaves the entry NOT watched', async () => {
    await submit(mk(ok()), createGate(), [RATING_OP('r1', 'ER1', 5)])
    const row = store.getSyncRow('entries', 'episode:ER1') as any
    // The same condition handlers.ts's alreadyWatched() tests: watched must
    // be strictly === true, and a missing key must read as "not watched".
    expect(row?.watched === true).toBe(false)
    expect(row.rating).toBe(5)
  })

  it('a rating-only push onto an already-watched entry keeps it watched, with its original plays intact', async () => {
    await submit(mk(ok()), createGate(), [OP('w2')]) // watched: true, plays: 1, entityId Ew2
    await submit(mk(ok()), createGate(), [RATING_OP('r2', 'Ew2', 4)])
    const row = store.getSyncRow('entries', 'episode:Ew2') as any
    expect(row.watched).toBe(true)
    expect(row.plays).toBe(1)
    expect(row.rating).toBe(4)
  })

  it('a normal watched push still mirrors watched:true with the right plays', async () => {
    const op = {
      opId: 'w3', table: 'entries' as const,
      pk: { entityKind: 'episode' as const, entityId: 'Ew3' },
      fields: { watched: true as const, plays: 7, batchId: null },
    }
    await submit(mk(ok()), createGate(), [op])
    const row = store.getSyncRow('entries', 'episode:Ew3') as any
    expect(row.watched).toBe(true)
    expect(row.plays).toBe(7)
  })

  // Fix round 2, Ruling D: a watched op and a rating op for the same entity
  // landing in ONE applied batch (reachable via flushOutbox after a gate
  // halt) must merge in-memory, not via a getSyncRow read that predates the
  // batch -- otherwise whichever op is processed second either erases the
  // other's fields (a fresh watched row has no `rating` key) or is itself
  // built from a stale pre-batch read (a rating op reading `getSyncRow`
  // before the watched op in the SAME batch has flushed anything). Both
  // orderings are exercised in one applied array, on two different entities.
  it('merges a watched op and a rating op for the same entity within one applied batch, regardless of order', async () => {
    const ops = [
      WATCHED_OP('a1', 'EA', 3), RATING_OP('a2', 'EA', 5), // watched then rating
      RATING_OP('b1', 'EB', 4), WATCHED_OP('b2', 'EB', 7), // rating then watched
    ]
    await submit(mk(ok()), createGate(), ops)
    expect(store.getSyncRow('entries', 'episode:EA')).toMatchObject({ watched: true, plays: 3, rating: 5 })
    expect(store.getSyncRow('entries', 'episode:EB')).toMatchObject({ watched: true, plays: 7, rating: 4 })
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
