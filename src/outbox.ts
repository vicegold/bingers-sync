import type { Op, DatedWrite } from './plan.js'
import { pushOps, applyDates, type SyncDeps } from './bingers/sync.js'
import { notify } from './notify.js'

export type Gate = { halted: boolean; reason: string | null; halt(reason: string): void; clear(): void }

/**
 * 'sent'    every op confirmed applied by the server
 * 'partial' some ops confirmed, the rest re-queued for retry
 * 'queued'  nothing landed, everything is in the outbox
 * 'halted'  the write gate is closed; work is queued, not lost
 */
export type Outcome = 'sent' | 'partial' | 'queued' | 'halted'

export function createGate(): Gate {
  return {
    halted: false, reason: null,
    halt(reason: string) { this.halted = true; this.reason = reason },
    clear() { this.halted = false; this.reason = null },
  }
}

export function backoffMs(attempts: number): number {
  return Math.min(60_000 * 2 ** attempts, 3_600_000)
}

/**
 * Close the write gate. Every path that halts goes through here so the spec's
 * "Bingers 401 -> stop writing, keep queueing, notify" holds no matter which
 * call (push, flush, or the date-correction read/patch) saw the 401.
 */
async function haltGate(deps: SyncDeps, gate: Gate, reason: string): Promise<void> {
  const already = gate.halted
  gate.halt(reason)
  if (already) return
  try { deps.store.recordFailure('gate', `writes halted: ${reason}`, { reason }) } catch { /* store is best-effort here */ }
  await notify(deps.notifyUrl ?? null, `Bingers writes halted: ${reason}`, deps.fetchImpl)
}

function isUnauthorized(msg: string): boolean {
  return msg.includes('401')
}

function datedKey(d: { entityKind: string; entityId: string }): string {
  return `${d.entityKind}:${d.entityId}`
}

function opIsEntry(o: Op): o is Extract<Op, { table: 'entries' }> {
  return o.table === 'entries'
}

/**
 * Mirror a confirmed write into sync_state immediately, instead of waiting up
 * to SYNC_PULL_INTERVAL_MIN for the next pull to tell us what we already know.
 * During a binge this is what stops every subsequent scrobble of the same show
 * from re-evaluating and re-pushing the episodes earlier scrobbles just wrote.
 * Conservative by construction: it only ever ADDS knowledge of writes we made.
 */
function mirrorApplied(deps: SyncDeps, applied: Op[]): void {
  const entries: { pk: string; row: unknown }[] = []
  const follows: { pk: string; row: unknown }[] = []
  for (const o of applied) {
    if (opIsEntry(o)) {
      entries.push({
        pk: datedKey(o.pk),
        row: { entityKind: o.pk.entityKind, entityId: o.pk.entityId, watched: true, plays: o.fields.plays, deletedAt: null },
      })
    } else if ('deleted' in o) {
      follows.push({ pk: o.pk.titleId, row: { titleId: o.pk.titleId, deletedAt: new Date().toISOString() } })
    } else {
      follows.push({ pk: o.pk.titleId, row: { titleId: o.pk.titleId, kind: o.fields.kind, deletedAt: null } })
    }
  }
  if (entries.length) deps.store.putSyncRows('entries', entries)
  if (follows.length) deps.store.putSyncRows('follows', follows)
}

/**
 * Correct the dates of writes that actually landed. A 401 here means the same
 * thing it means on the push path -- the session is dead -- so it halts the
 * gate rather than escaping to a generic "handler threw" with the gate open.
 */
async function correctDates(deps: SyncDeps, gate: Gate, dated: DatedWrite[]): Promise<void> {
  if (dated.length === 0) return
  try {
    await applyDates(deps, dated)
  } catch (e) {
    const msg = (e as Error).message
    // applyDates throws only on 401; anything else it records per-item itself.
    // Whatever it threw on, the un-corrected remainder is recorded in full so
    // the dates can be replayed by hand.
    deps.store.recordFailure('applyDates', `date correction aborted: ${msg}`, { dated })
    if (isUnauthorized(msg)) await haltGate(deps, gate, msg)
  }
}

export async function submit(deps: SyncDeps, gate: Gate, ops: Op[], dated: DatedWrite[] = []): Promise<Outcome> {
  if (ops.length === 0) return 'sent'
  if (gate.halted) { deps.store.enqueueOps(ops as any, dated); return 'halted' }

  let result: Awaited<ReturnType<typeof pushOps>>
  try {
    result = await pushOps(deps, ops)
  } catch (e) {
    const msg = (e as Error).message
    deps.store.enqueueOps(ops as any, dated)
    if (isUnauthorized(msg)) { await haltGate(deps, gate, msg); return 'halted' }
    return 'queued'
  }

  if ('dryRun' in result) {
    // Nothing was sent, so nothing may be marked done -- but nothing failed
    // either, and queueing under DRY_RUN would build an outbox of writes the
    // operator explicitly asked not to make. applyDates is itself dry-run
    // aware and logs what it would have corrected.
    await correctDates(deps, gate, dated)
    return 'sent'
  }

  // A 200 does NOT mean every op landed: the server reports per-op status in
  // `results`, and an op it did not confirm is an op that was never written.
  const appliedIds = new Set(result.appliedIds)
  const applied = ops.filter(o => appliedIds.has(o.opId))
  const rejected = ops.filter(o => !appliedIds.has(o.opId))

  if (applied.length) mirrorApplied(deps, applied)

  if (rejected.length) {
    deps.store.enqueueOps(rejected as any, dated)
    deps.store.recordFailure(
      'sync/push',
      `bingers confirmed ${applied.length}/${ops.length} op(s); ${rejected.length} queued for retry`,
      { rejected: rejected.map(o => ({ opId: o.opId, table: o.table, pk: o.pk })) },
    )
  }

  const appliedDated = dated.filter(d => applied.some(o => opIsEntry(o) && datedKey(o.pk) === datedKey(d)))
  await correctDates(deps, gate, appliedDated)

  if (rejected.length === 0) return 'sent'
  return applied.length > 0 ? 'partial' : 'queued'
}

export async function flushOutbox(deps: SyncDeps, gate: Gate): Promise<number> {
  if (gate.halted) return 0
  const due = deps.store.dueOps(new Date().toISOString())
  if (due.length === 0) return 0
  try {
    const result = await pushOps(deps, due as Op[])
    if ('dryRun' in result) {
      // pushOps sent nothing (dry run) -- treat exactly like "no ops were
      // applied" rather than the old fallback of assuming all of them were.
      // Ops queued while live must survive a restart into DRY_RUN=true, not
      // be silently marked applied on the next flush.
      console.log('[DRY_RUN] flushOutbox: skipping, nothing applied for', due.length, 'queued op(s)')
      return 0
    }
    const appliedIds = new Set(result.appliedIds)
    const applied = due.filter(o => appliedIds.has(o.opId))
    const rejected = due.filter(o => !appliedIds.has(o.opId))
    // Read the intended watch times BEFORE markApplied, so the lookup never
    // depends on how an applied row is retained.
    const watchedAt = deps.store.watchedAtFor(applied.map(o => o.opId))
    if (applied.length) deps.store.markApplied(applied.map(o => o.opId))
    for (const o of rejected) {
      const next = new Date(Date.now() + backoffMs(deps.store.attemptsFor(o.opId))).toISOString()
      deps.store.reschedule(o.opId, next)
    }
    if (applied.length) mirrorApplied(deps, applied as Op[])

    // The dated half of the original Plan, restored from the outbox: without
    // this a flush lands every backfilled episode stamped with flush time.
    const dated: DatedWrite[] = []
    for (const o of applied as Op[]) {
      const w = watchedAt[o.opId]
      if (w && opIsEntry(o)) dated.push({ entityKind: o.pk.entityKind, entityId: o.pk.entityId, watchedAt: w })
    }
    await correctDates(deps, gate, dated)

    return applied.length
  } catch (e) {
    const msg = (e as Error).message
    if (isUnauthorized(msg)) await haltGate(deps, gate, msg)
    for (const o of due) {
      const next = new Date(Date.now() + backoffMs(deps.store.attemptsFor(o.opId))).toISOString()
      deps.store.reschedule(o.opId, next)
    }
    return 0
  }
}
