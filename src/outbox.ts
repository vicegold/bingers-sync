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
 * How many EXPLICIT bingers rejections an op may collect before it is
 * abandoned. Without a cap an op the server permanently refuses stays
 * `pending` forever; since src/ratings/toPlex.ts's Layer 1 consults
 * hasPendingRatingOp(), that is not merely wasted work any more -- it locks
 * the entity out of the bingers->plex direction permanently, so the user's
 * genuine rating is refused for good.
 *
 * Counted against `rejections`, not `attempts`: a transport failure means the
 * server never answered, and an outage must not spend the budget of a write
 * that was never actually refused.
 */
export const MAX_OP_REJECTIONS = 10

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
 * Mirror confirmed writes into sync_state immediately, instead of waiting up
 * to SYNC_PULL_INTERVAL_MIN for the next pull to tell us what we already know.
 * During a binge this is what stops every subsequent scrobble of the same show
 * from re-evaluating and re-pushing the episodes earlier scrobbles just wrote.
 *
 * Each entries op is merged into an in-memory row for its pk rather than
 * written independently: a watched op asserts watched/plays/deletedAt, a
 * rating-only op asserts only `rating`, and neither erases what the other
 * asserted. The row is seeded at most once per pk, lazily, from whatever
 * `getSyncRow` returns BEFORE this batch; every op after that seed mutates
 * the same in-memory row, so two ops for the same entity landing in one
 * `applied` array (reachable via flushOutbox after a gate halt) end up with
 * the union of what they asserted regardless of which one came first --
 * never a rating op reading stale pre-batch state and clobbering a watched
 * flag the other op in the SAME batch just confirmed.
 *
 * That same lazy seed also changes the single-op case, not just multi-op
 * batches: a plain watched op, alone in its own `applied` array, used to be
 * written as a fresh row (entityKind/entityId/watched/plays/deletedAt and
 * nothing else), unconditionally replacing whatever was stored. It now
 * seeds from the existing row first and merges on top, so a `rating` an
 * earlier, separate submit() call already wrote survives a later watched-only
 * push instead of being silently erased by it.
 */
function mirrorApplied(deps: SyncDeps, applied: Op[]): void {
  const entryRows = new Map<string, Record<string, unknown>>()
  const follows: { pk: string; row: unknown }[] = []

  function rowFor(pk: string, o: Extract<Op, { table: 'entries' }>): Record<string, unknown> {
    let row = entryRows.get(pk)
    if (!row) {
      const existing = deps.store.getSyncRow('entries', pk) as Record<string, unknown> | null
      // No prior row means the identity fields are written with NO `watched`
      // key at all: absent, not false -- alreadyWatched() tests
      // `row.watched === true`, and a missing key honestly means "we don't know".
      row = existing ? { ...existing } : { entityKind: o.pk.entityKind, entityId: o.pk.entityId, deletedAt: null }
      entryRows.set(pk, row)
    }
    return row
  }

  for (const o of applied) {
    if (opIsEntry(o)) {
      const pk = datedKey(o.pk)
      const row = rowFor(pk, o)
      if ('watched' in o.fields) {
        row.watched = true
        row.plays = o.fields.plays
        row.deletedAt = null
      } else {
        row.rating = o.fields.rating
      }
    } else if ('deleted' in o) {
      follows.push({ pk: o.pk.titleId, row: { titleId: o.pk.titleId, deletedAt: new Date().toISOString() } })
    } else {
      follows.push({ pk: o.pk.titleId, row: { titleId: o.pk.titleId, kind: o.fields.kind, deletedAt: null } })
    }
  }
  const entries = [...entryRows.entries()].map(([pk, row]) => ({ pk, row }))
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

  // Ordering trade-off, known and accepted: mirrorApplied runs BEFORE
  // correctDates below. If date correction then 401s (or otherwise fails),
  // sync_state already records the episode as watched, so nothing later
  // infers "not yet backfilled" and revisits it -- the push-time date sticks
  // until the recorded applyDates failure is replayed by hand. Reordering
  // would leave a confirmed write unmirrored on a date-correction hiccup,
  // which is worse, so this is deliberate, not an oversight.
  // One server response, one local write. Mirroring what landed and queueing
  // what did not are halves of the same fact, so they commit together or not
  // at all, and local state never records only part of a response.
  //
  // Be precise about what that buys, because it is NOT "the rejected ops are
  // safe". If the second half throws, those ops are gone either way -- the
  // throw happened while queueing them, and no rollback brings back work that
  // was never written. What the transaction adds is that the FIRST half is
  // discarded too, so the outcome is "none of this response is recorded"
  // rather than "the applied half is recorded and the rejected half silently
  // is not". The first is re-derivable: sync_state is the local mirror, and
  // the next pull (or the next scrobble for the same entity) learns the state
  // from the server. The second is a half-truth nothing later corrects,
  // because the mirror asserting the write landed is exactly what stops the
  // forward path revisiting it.
  deps.store.tx(() => {
    if (applied.length) mirrorApplied(deps, applied)
    if (rejected.length) {
      deps.store.enqueueOps(rejected as any, dated)
      deps.store.recordFailure(
        'sync/push',
        `bingers confirmed ${applied.length}/${ops.length} op(s); ${rejected.length} queued for retry`,
        { rejected: rejected.map(o => ({ opId: o.opId, table: o.table, pk: o.pk })) },
      )
    }
  })

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

    // markApplied and mirrorApplied describe ONE event -- "these ops landed"
    // -- and the mirror exists precisely so local state matches what the
    // server was told. Run in separate transactions (with the reschedule loop
    // between them, as they were) a crash in the gap left the op no longer
    // `pending` while sync_state still held the PRE-push value: a rating
    // src/ratings/toPlex.ts would then read as a deliberate bingers-side
    // change and write back over the plex value it came from. The transaction
    // covers mirrorApplied's getSyncRow READ as well as its write, so a
    // concurrent writer cannot interleave between the two.
    //
    // Same known ordering trade-off as in submit() above: this runs before
    // correctDates, so a date-correction failure below leaves the push-time
    // date on a row sync_state already marks watched.
    if (applied.length) {
      deps.store.tx(() => {
        deps.store.markApplied(applied.map(o => o.opId))
        mirrorApplied(deps, applied as Op[])
      })
    }

    for (const o of rejected) {
      // An explicit refusal, not a transport failure -- see MAX_OP_REJECTIONS.
      deps.store.recordRejection(o.opId)
      if (deps.store.rejectionsFor(o.opId) >= MAX_OP_REJECTIONS) {
        // Terminal, and recorded in full rather than silently dropped: the
        // op leaves `pending` so it stops being retried and stops locking its
        // entity out of the bingers->plex direction, and the failure row
        // carries everything needed to replay it by hand.
        deps.store.abandonOp(o.opId)
        deps.store.recordFailure(
          'outbox',
          `op ${o.opId} abandoned after ${MAX_OP_REJECTIONS} bingers rejection(s): ${o.table} ${JSON.stringify(o.pk)}`,
          { opId: o.opId, table: o.table, pk: o.pk, fields: (o as any).fields ?? null },
        )
        continue
      }
      const next = new Date(Date.now() + backoffMs(deps.store.attemptsFor(o.opId))).toISOString()
      deps.store.reschedule(o.opId, next)
    }

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
