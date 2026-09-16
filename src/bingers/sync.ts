import { randomUUID } from 'node:crypto'
import type { Store } from '../store.js'
import type { Auth } from './auth.js'
import type { Op, DatedWrite } from '../plan.js'

const API = 'https://api.bingers.app'

export type SyncDeps = {
  auth: Auth; store: Store; userAgent: string; dryRun: boolean
  watchDateToleranceSec: number; fetchImpl?: typeof fetch
}

function headers(deps: SyncDeps, json = false): Record<string, string> {
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
  return res
}

export async function pushOps(deps: SyncDeps, ops: Op[]) {
  if (ops.length === 0) return { applied: 0, rows: {} }
  if (deps.dryRun) {
    console.log('[DRY_RUN] would POST /sync/push', JSON.stringify({ ops }, null, 2))
    return { dryRun: true as const }
  }
  const body = JSON.stringify({ clientBatchId: randomUUID(), ops })
  const res = await call(deps, `${API}/sync/push`, { method: 'POST', headers: headers(deps, true), body })
  if (!res.ok) throw new Error(`sync/push -> ${res.status}`)
  const j = (await res.json()) as { results: { opId: string; status: string }[]; rows: unknown }
  return { applied: j.results.filter(r => r.status === 'applied').length, rows: j.rows }
}

export async function applyDates(deps: SyncDeps, dated: DatedWrite[]): Promise<number> {
  if (deps.dryRun) {
    if (dated.length) console.log('[DRY_RUN] would correct dates for', dated)
    return 0
  }
  let patched = 0
  for (const d of dated) {
    const url = `${API}/me/watches?entityKind=${d.entityKind}&entityId=${d.entityId}`
    const res = await call(deps, url, { headers: headers(deps) })
    if (!res.ok) continue
    const { watches = [] } = (await res.json()) as { watches?: { id: string; watchedAt: string }[] }
    const target = watches[watches.length - 1]
    if (!target) continue
    const drift = Math.abs(Date.parse(target.watchedAt) - Date.parse(d.watchedAt)) / 1000
    if (drift <= deps.watchDateToleranceSec) continue
    const p = await call(deps, `${API}/me/watches/${target.id}`, {
      method: 'PATCH', headers: headers(deps, true),
      body: JSON.stringify({ watchedAt: d.watchedAt, entityKind: d.entityKind, entityId: d.entityId }),
    })
    if (p.ok) patched++
  }
  return patched
}

export async function pullOnce(deps: SyncDeps): Promise<void> {
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
  for (const [k, v] of Object.entries(b.cursors ?? {})) {
    if (typeof v === 'string') deps.store.setCursor(k, v)
  }
}
