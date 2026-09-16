import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { openStore } from './store.js'
import { createAuth } from './bingers/auth.js'
import { parsePlexScrobble, parsePulsarr } from './routes/parse.js'
import { handlePlex, handlePulsarr, mirrorFreshness, type AppDeps } from './handlers.js'
import { pullOnce } from './bingers/sync.js'
import { createGate, flushOutbox } from './outbox.js'
import { notify } from './notify.js'
import { parseMagicLinkToken, redeemMagicLink } from './bingers/magic-link.js'
import { setupPage } from './routes/setup-page.js'

/**
 * /setup is self-closing: it exists only to acquire a session cookie, so it
 * answers while there is none, and again once the one we had went dead (a 401
 * on any write path halts the gate). The rest of the time it is a 404, which
 * keeps a LAN neighbour from re-pointing the sync at their own account.
 */
function setupOpen(deps: AppDeps): boolean {
  return !deps.auth.hasSession() || deps.gate.halted
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.get('/health', c => {
    // Mirror freshness is the single most load-bearing invariant here: while it
    // is false, backfill is suppressed, so it has to be visible from outside.
    const mirror = mirrorFreshness(deps.store, deps.config.syncPullIntervalMin)
    return c.json({
      ok: true, dryRun: deps.config.dryRun,
      sessionDaysRemaining: deps.auth.daysRemaining(),
      writesHalted: deps.gate.halted,
      haltReason: deps.gate.reason,
      outboxDepth: deps.store.outboxDepth(),
      failures: deps.store.listFailures(1).length,
      mirrorSyncedAt: mirror.syncedAt,
      mirrorFresh: mirror.fresh,
      mirrorMaxAgeMin: mirror.maxAgeMin,
      backfillEnabled: mirror.fresh,
      setupRequired: setupOpen(deps),
    })
  })

  app.get('/setup', c => {
    if (!setupOpen(deps)) return c.notFound()
    return c.html(setupPage({}))
  })

  app.post('/setup', async c => {
    if (!setupOpen(deps)) return c.notFound()

    const body = await c.req.parseBody()
    const token = parseMagicLinkToken(String(body.link ?? ''))
    if (!token) {
      return c.html(setupPage({
        error: 'That does not look like a magic link. Paste the whole link from the email, '
          + 'the one starting with https://bingers.app/m?token=',
      }), 400)
    }

    const r = await redeemMagicLink(
      { auth: deps.auth, userAgent: deps.config.bingersUserAgent, fetchImpl: deps.fetchImpl },
      token,
    )
    if (!r.ok) {
      console.log(`[setup] redeem failed -> ${r.reason}`)
      return c.html(setupPage({
        error: `Bingers would not accept that link (${r.reason}). A link is single-use and short-lived — if you tapped it in the email, it is already spent. Request a fresh one and copy it instead.`,
      }), 502)
    }

    // The session that halted writes is gone; the new one has not failed at
    // anything yet, so the gate reopens and the outbox drains on its next tick.
    if (deps.gate.halted) { deps.gate.clear(); console.log('[setup] session acquired, resuming writes') }
    // Best-effort: fills in expiresAt so /health reports the new session's life
    // immediately rather than null until the next daily heartbeat.
    try { await deps.auth.heartbeat(deps.fetchImpl) } catch (e) {
      console.log(`[setup] heartbeat after setup failed -> ${(e as Error).message}`)
    }
    console.log('[setup] session stored')
    return c.html(setupPage({ done: true }))
  })

  // Always 200: a non-2xx makes Plex retry an event that will never resolve.
  app.post('/plex', async c => {
    try {
      const form = await c.req.formData()
      // Log EVERY inbound event, including ones we drop. Without this, "nothing
      // happened" is indistinguishable from "never arrived" -- plex sends ~12
      // event types and only media.scrobble is actionable.
      const raw = form.get('payload')
      let ev = '<no payload part>', who = '?'
      if (typeof raw === 'string') {
        try {
          const p = JSON.parse(raw) as { event?: string; Account?: { title?: string } }
          ev = p?.event ?? '<no event>'
          who = p?.Account?.title ?? '<no account>'
        } catch { ev = '<unparseable json>' }
      }
      const s = parsePlexScrobble(form)
      if (!s) {
        console.log(`[plex] in  event=${ev} account=${who} -> ignored (not an actionable scrobble)`)
        return c.json({ status: 'ignored' })
      }
      const res = await handlePlex(deps, s)
      const what = s.type === 'episode'
        ? `${s.grandparentTitle} S${s.season}E${s.number}`
        : `${s.title} (${s.year})`
      console.log(`[plex] in  event=${ev} account=${who} ${what} -> ${res.status}${res.reason ? ` (${res.reason})` : ''}`)
      return c.json(res)
    } catch (e) {
      // recordFailure can itself throw (e.g. the store is what failed) -- the
      // 200 below must not depend on that succeeding, or an unhealthy store
      // turns this into the 500-and-retry-forever this catch exists to avoid.
      try { deps.store.recordFailure('plex', `handler threw: ${(e as Error).message}`, null) }
      catch (e2) { console.error('[plex] recordFailure failed', (e2 as Error).message) }
      return c.json({ status: 'failed' })
    }
  })

  app.post('/pulsarr', async c => {
    try {
      const body = await c.req.json() as { event?: string; data?: { addedBy?: { username?: string } } }
      const ev = body?.event ?? '<no event>'
      const who = body?.data?.addedBy?.username ?? '<no user>'
      const e = parsePulsarr(body)
      if (!e) {
        console.log(`[pulsarr] in  event=${ev} user=${who} -> ignored`)
        return c.json({ status: 'ignored' })
      }
      const res = await handlePulsarr(deps, e)
      console.log(`[pulsarr] in  event=${ev} user=${who} ${e.title} -> ${res.status}${res.reason ? ` (${res.reason})` : ''}`)
      return c.json(res)
    } catch (e) {
      try { deps.store.recordFailure('pulsarr', `handler threw: ${(e as Error).message}`, null) }
      catch (e2) { console.error('[pulsarr] recordFailure failed', (e2 as Error).message) }
      return c.json({ status: 'failed' })
    }
  })

  return app
}

async function main() {
  const config = loadConfig(process.env)
  const store = openStore(config.dbPath)
  const auth = createAuth(store, config.bingersCookie, config.bingersUserAgent)
  const gate = createGate()
  const deps: AppDeps = { config, store, auth, gate }
  const sd = {
    auth, store, userAgent: config.bingersUserAgent, dryRun: config.dryRun,
    watchDateToleranceSec: config.watchDateToleranceSec, notifyUrl: config.notifyUrl,
  }

  const pull = async () => {
    // A failed pull leaves the mirror stale; serve() still starts (the webhooks
    // must keep returning 200), but handlePlex reads the freshness marker and
    // suppresses backfill until a pull succeeds again.
    try { await pullOnce(sd) } catch (e) {
      console.error('[pull]', (e as Error).message)
      store.recordFailure('pull', `sync/pull failed: ${(e as Error).message}`, null)
      await notify(config.notifyUrl, `Bingers sync/pull failed: ${(e as Error).message} — backfill suppressed until the mirror refreshes`)
    }
  }
  const beat = async () => {
    // Same reasoning as the guard in pullOnce: with no cookie this can only
    // 401, and the catch below would notify about a session that was never
    // configured. An unconfigured container is not a failing one. (Like the
    // gate.clear() below, this runs but is not reachable from a test -- beat is
    // a closure in main() and not exported.)
    if (!auth.hasSession()) { console.log(`[auth] no session yet — open http://localhost:${config.port}/setup`); return }
    try {
      const { expiresAt } = await auth.heartbeat()
      const days = auth.daysRemaining()
      console.log('[auth] expiresAt', expiresAt, `(${days} days)`)
      // A successful heartbeat means the session works again, so writing may resume.
      // This line IS reachable at runtime (beat() runs on the setInterval below,
      // and on a healthy heartbeat after a halt, gate.clear() fires). It is only
      // untestable, because beat is a closure inside main() and not exported --
      // do not delete it as dead code on the strength of a coverage report.
      if (gate.halted) { gate.clear(); console.log('[auth] session healthy, resuming writes') }
      if (days != null && days < 30) await notify(config.notifyUrl, `Bingers session expires in ${days} days — re-capture needed`)
    } catch (e) {
      await notify(config.notifyUrl, `Bingers heartbeat failed: ${(e as Error).message}`)
    }
  }
  const flush = async () => {
    try {
      const n = await flushOutbox(sd, gate)
      if (n) console.log(`[outbox] flushed ${n} op(s)`)
    } catch (e) { console.error('[outbox]', (e as Error).message) }
  }

  await pull(); await beat()
  setInterval(pull, config.syncPullIntervalMin * 60_000)
  setInterval(beat, 24 * 60 * 60_000)
  setInterval(flush, 60_000)

  console.log(`bingers-sync on :${config.port} (DRY_RUN=${config.dryRun})`)
  serve({ fetch: createApp(deps).fetch, port: config.port })
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) void main()
