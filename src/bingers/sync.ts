import { randomUUID } from 'node:crypto'
import type { Store } from '../store.js'
import type { Auth } from './auth.js'
import type { Op, DatedWrite } from '../plan.js'

const API = 'https://api.bingers.app'

export type SyncDeps = {
  auth: Auth; store: Store; userAgent: string; dryRun: boolean
  watchDateToleranceSec: number; fetchImpl?: typeof fetch
  notifyUrl?: string | null
}

/**
 * Thrown instead of sending an authenticated request with an empty cookie.
 * Doing so would 401, and a 401 on the write path halts the gate, records a
 * failure and fires the notify webhook -- so an unconfigured container would
 * announce itself as a broken one. Deliberately carries no "401" in its
 * message: isUnauthorized() in outbox.ts keys off that, and this is the one
 * authentication failure that must NOT halt the gate. Callers that already
 * queue on a throw (submit, flushOutbox) therefore do the right thing with no
 * change of their own.
 *
 * It lives at the choke point every authenticated call passes through, so a
 * call site added later cannot forget the guard the way the write path did.
 */
export class NoSessionError extends Error {
  constructor() { super('no bingers session yet — open /setup') }
}

function headers(deps: SyncDeps, json = false): Record<string, string> {
  if (!deps.auth.hasSession()) throw new NoSessionError()
  const h: Record<string, string> = {
    Cookie: deps.auth.cookieHeader(), 'User-Agent': deps.userAgent, Accept: 'application/json',
  }
  if (json) h['Content-Type'] = 'application/json'
  return h
}

async function call(deps: SyncDeps, url: string, init?: RequestInit): Promise<Response> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(url, init)
  deps.auth.absorb(res)
  // A 401 from any authenticated call is the session telling us it is spent.
  // Recorded on auth, not just the gate, because a 401 on a READ (pull) never
  // halts writes -- yet it is the commonest way a session dies, and /setup has
  // to reopen for it.
  if (res.status === 401) deps.auth.noteUnauthorized()
  return res
}

export async function pushOps(deps: SyncDeps, ops: Op[]) {
  // dryRun is checked before the empty-ops shortcut so callers that switch on
  // `'dryRun' in res` see one consistent shape for every call made under
  // DRY_RUN, regardless of whether there happened to be anything to send.
  if (deps.dryRun) {
    if (ops.length) console.log('[DRY_RUN] would POST /sync/push', JSON.stringify({ ops }, null, 2))
    return { dryRun: true as const }
  }
  if (ops.length === 0) return { applied: 0, appliedIds: [] as string[], rows: {} }
  const body = JSON.stringify({ clientBatchId: randomUUID(), ops })
  const res = await call(deps, `${API}/sync/push`, { method: 'POST', headers: headers(deps, true), body })
  if (!res.ok) throw new Error(`sync/push -> ${res.status}`)
  const j = (await res.json()) as { results: { opId: string; status: string }[]; rows: unknown }
  const appliedIds = j.results.filter(r => r.status === 'applied').map(r => r.opId)
  return { applied: appliedIds.length, appliedIds, rows: j.rows }
}

export async function applyDates(deps: SyncDeps, dated: DatedWrite[]): Promise<number> {
  if (deps.dryRun) {
    if (dated.length) console.log('[DRY_RUN] would correct dates for', dated)
    return 0
  }
  let patched = 0
  for (const d of dated) {
    const url = `${API}/me/watches?entityKind=${d.entityKind}&entityId=${encodeURIComponent(d.entityId)}`
    const res = await call(deps, url, { headers: headers(deps) })
    if (res.status === 401) throw new Error(`me/watches -> 401`)
    if (!res.ok) {
      deps.store.recordFailure('applyDates', `GET /me/watches -> ${res.status}`, d)
      continue
    }
    const { watches = [] } = (await res.json()) as { watches?: { id: string; watchedAt: string }[] }
    if (!watches.length) continue
    // Select by VALUE (greatest watchedAt), not by array position — response
    // ordering from the server is unverified and a rewatch has multiple rows.
    const target = watches.reduce((a, b) => (Date.parse(b.watchedAt) > Date.parse(a.watchedAt) ? b : a))
    const drift = Math.abs(Date.parse(target.watchedAt) - Date.parse(d.watchedAt)) / 1000
    if (!Number.isFinite(drift)) continue
    if (drift <= deps.watchDateToleranceSec) continue
    const p = await call(deps, `${API}/me/watches/${encodeURIComponent(target.id)}`, {
      method: 'PATCH', headers: headers(deps, true),
      body: JSON.stringify({ watchedAt: d.watchedAt, entityKind: d.entityKind, entityId: d.entityId }),
    })
    if (p.status === 401) throw new Error(`me/watches PATCH -> 401`)
    if (p.ok) {
      patched++
    } else {
      deps.store.recordFailure('applyDates', `PATCH /me/watches/${target.id} -> ${p.status}`, d)
    }
  }
  return patched
}

export async function pullOnce(deps: SyncDeps): Promise<void> {
  // No cookie means the container has never been set up. Pulling would 401,
  // and a 401 here writes a failures row and fires the notify webhook -- so an
  // unconfigured container would announce itself as a broken one. Do nothing
  // instead and leave the mirror stale, which is exactly what it is. /setup is
  // where this gets resolved; the next scheduled pull picks up from there.
  if (!deps.auth.hasSession()) return

  const names = ['follows', 'entries', 'catalog', 'prefs', 'settings'] as const
  const qs = new URLSearchParams()
  for (const n of names) {
    const c = deps.store.getCursor(n)
    if (c) qs.set(n, c)
  }
  qs.set('notifKinds', '2'); qs.set('titlesLang', 'de'); qs.set('trigger', 'foreground')

  const res = await call(deps, `${API}/sync/pull?${qs}`, { headers: headers(deps) })
  if (!res.ok) throw new Error(`sync/pull -> ${res.status}`)
  const b = (await res.json()) as any

  if (Array.isArray(b.follows) && b.follows.length) {
    deps.store.putSyncRows('follows', b.follows.map((r: any) => ({ pk: r.titleId, row: r })))
  }
  if (Array.isArray(b.entries) && b.entries.length) {
    deps.store.putSyncRows('entries', b.entries.map((r: any) => ({ pk: `${r.entityKind}:${r.entityId}`, row: r })))
  }
  // Only advance cursors for streams we actually persisted rows for above.
  // Sending a cursor for a stream we don't yet store (catalog/prefs/settings)
  // is fine, but persisting its returned cursor would permanently skip any
  // delta the server sends for it before we implement storage.
  const PERSISTED = new Set(['follows', 'entries'])
  for (const [k, v] of Object.entries(b.cursors ?? {})) {
    if (PERSISTED.has(k) && typeof v === 'string') deps.store.setCursor(k, v)
  }

  // Only here, past every throw above: the local mirror now genuinely reflects
  // Bingers as of this moment. Readers that infer absence from sync_state key
  // off this marker.
  deps.store.markMirrorSynced()
}
