import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { openStore } from './store.js'
import { createAuth } from './bingers/auth.js'
import { parsePlexScrobble, parsePulsarr } from './routes/parse.js'
import { handlePlex, handlePulsarr, type AppDeps } from './handlers.js'
import { pullOnce } from './bingers/sync.js'
import { createGate, flushOutbox } from './outbox.js'
import { notify } from './notify.js'

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.get('/health', c => c.json({
    ok: true, dryRun: deps.config.dryRun,
    sessionDaysRemaining: deps.auth.daysRemaining(),
    writesHalted: deps.gate.halted,
    outboxDepth: deps.store.outboxDepth(),
    failures: deps.store.listFailures(1).length,
  }))

  // Always 200: a non-2xx makes Plex retry an event that will never resolve.
  app.post('/plex', async c => {
    try {
      const s = parsePlexScrobble(await c.req.formData())
      if (!s) return c.json({ status: 'ignored' })
      return c.json(await handlePlex(deps, s))
    } catch (e) {
      deps.store.recordFailure('plex', `handler threw: ${(e as Error).message}`, null)
      return c.json({ status: 'failed' })
    }
  })

  app.post('/pulsarr', async c => {
    try {
      const e = parsePulsarr(await c.req.json())
      if (!e) return c.json({ status: 'ignored' })
      return c.json(await handlePulsarr(deps, e))
    } catch (e) {
      deps.store.recordFailure('pulsarr', `handler threw: ${(e as Error).message}`, null)
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
  const sd = { auth, store, userAgent: config.bingersUserAgent, dryRun: config.dryRun, watchDateToleranceSec: config.watchDateToleranceSec }

  const pull = async () => {
    try { await pullOnce(sd) } catch (e) { console.error('[pull]', (e as Error).message) }
  }
  const beat = async () => {
    try {
      const { expiresAt } = await auth.heartbeat()
      const days = auth.daysRemaining()
      console.log('[auth] expiresAt', expiresAt, `(${days} days)`)
      // A successful heartbeat means the session works again, so writing may resume.
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
