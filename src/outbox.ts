import type { Op } from './plan.js'
import { pushOps, type SyncDeps } from './bingers/sync.js'

export type Gate = { halted: boolean; reason: string | null; halt(reason: string): void; clear(): void }

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

export async function submit(deps: SyncDeps, gate: Gate, ops: Op[]): Promise<'sent' | 'queued' | 'halted'> {
  if (ops.length === 0) return 'sent'
  if (gate.halted) { deps.store.enqueueOps(ops as any); return 'halted' }
  try {
    await pushOps(deps, ops)
    return 'sent'
  } catch (e) {
    const msg = (e as Error).message
    deps.store.enqueueOps(ops as any)
    if (msg.includes('401')) { gate.halt(msg); return 'halted' }
    return 'queued'
  }
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
    if (applied.length) deps.store.markApplied(applied.map(o => o.opId))
    for (const o of rejected) {
      const next = new Date(Date.now() + backoffMs(deps.store.attemptsFor(o.opId))).toISOString()
      deps.store.reschedule(o.opId, next)
    }
    return applied.length
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('401')) gate.halt(msg)
    for (const o of due) {
      const next = new Date(Date.now() + backoffMs(deps.store.attemptsFor(o.opId))).toISOString()
      deps.store.reschedule(o.opId, next)
    }
    return 0
  }
}
