import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { loadConfig } from './config.js'
import { openStore } from './store.js'
import { createAuth } from './bingers/auth.js'
import { parsePlexScrobble, parsePulsarr } from './routes/parse.js'
import { handlePlex, handlePulsarr, mirrorFreshness, syncDeps, type AppDeps } from './handlers.js'
import { pullOnce } from './bingers/sync.js'
import { createGate, flushOutbox } from './outbox.js'
import { notify } from './notify.js'
import { parseMagicLinkToken, redeemMagicLink } from './bingers/magic-link.js'
import { setupPage } from './routes/setup-page.js'
import { reconcileWatchlist } from './reverse.js'
import { syncRatingsFromPlex, type RatingSyncResult } from './ratings/fromPlex.js'
import { syncRatingsToPlex, type RatingToPlexResult } from './ratings/toPlex.js'

/**
 * /setup is self-closing: it exists only to acquire a session cookie, so it
 * answers while there is none and again once the one we had went dead. The rest
 * of the time it is a 404.
 *
 * All three conditions are needed, and the gate alone is not enough. A halted
 * gate only ever follows a 401 on a real WRITE -- and under DRY_RUN (the
 * default) no write ever reaches the network, so a session can expire with the
 * gate permanently open. auth.sessionDead() is what covers that: it sees both
 * a 401 on a read and an expiresAt that has simply passed.
 */
function setupOpen(deps: AppDeps): boolean {
  return !deps.auth.hasSession() || deps.auth.sessionDead() || deps.gate.halted
}

/**
 * A form POST is a CORS-simple request, so any page the operator's browser
 * loads can submit one at this port with no preflight and no need to read the
 * reply. Browsers attach Origin to every cross-site form POST, so a mismatch is
 * a drive-by. A request with no Origin at all is not from a browser (curl, the
 * tests) and is left alone -- what stops a hostile LAN host is the account
 * binding in the handler, not this.
 */
function sameOrigin(origin: string | undefined, url: string): boolean {
  if (!origin) return true
  try { return new URL(origin).host === new URL(url).host } catch { return false }
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
      // Ops this service has GIVEN UP delivering (MAX_OP_REJECTIONS explicit
      // bingers refusals). A dropped user write must never be silent; the
      // matching `failures` row carries the payload to replay by hand.
      abandonedOps: deps.store.abandonedDepth(),
      failures: deps.store.listFailures(1).length,
      mirrorSyncedAt: mirror.syncedAt,
      mirrorFresh: mirror.fresh,
      mirrorMaxAgeMin: mirror.maxAgeMin,
      backfillEnabled: mirror.fresh,
      setupRequired: setupOpen(deps),
      reverseSync: deps.config.reverseSync,
      watchlistLinked: deps.store.countPlexLinks('added'),
      ratingSync: deps.config.ratingSync,
      ratingsLinked: deps.store.countRatingLinks(),
      lastRatingRun: deps.lastRatingRun ? deps.lastRatingRun() : null,
    })
  })

  app.get('/setup', c => {
    if (!setupOpen(deps)) return c.notFound()
    return c.html(setupPage({}))
  })

  app.post('/setup', async c => {
    if (!setupOpen(deps)) return c.notFound()
    if (!sameOrigin(c.req.header('origin'), c.req.url)) return c.text('cross-origin post refused', 403)

    const body = await c.req.parseBody()
    const token = parseMagicLinkToken(String(body.link ?? ''))
    if (!token) {
      return c.html(setupPage({
        error: 'That does not look like a Bingers magic link. Paste the whole link from the email, '
          + 'the one starting with https://bingers.app/m?token= — not a link your mail provider '
          + 'rewrote to point at its own click tracker.',
      }), 400)
    }

    // Everything below can reject the link, and a rejected link must leave the
    // session exactly as it was rather than half-adopted.
    const before = deps.auth.snapshot()

    const r = await redeemMagicLink(
      { auth: deps.auth, userAgent: deps.config.bingersUserAgent, fetchImpl: deps.fetchImpl },
      token,
    )
    if (!r.ok) {
      deps.auth.restore(before)
      console.log(`[setup] redeem failed -> ${r.reason}`)
      return c.html(setupPage({
        error: `Bingers would not accept that link (${r.reason}). A link is single-use and short-lived — if you tapped it in the email, it is already spent. Request a fresh one and copy it instead.`,
      }), 502)
    }

    // Verify BEFORE trusting. A cookie that cannot fetch its own session is not
    // a working session, and reopening the write gate on it just 401s again on
    // the next scrobble and re-halts with a second notification. beat() has
    // always cleared the gate only after a good heartbeat; this is that rule.
    let session: Awaited<ReturnType<typeof deps.auth.heartbeat>>
    try {
      session = await deps.auth.heartbeat(deps.fetchImpl)
    } catch (e) {
      deps.auth.restore(before)
      console.log(`[setup] heartbeat after setup failed -> ${(e as Error).message}`)
      return c.html(setupPage({
        error: `That link was accepted, but the session it returned does not work (${(e as Error).message}). Nothing was changed. Request a fresh link and try again.`,
      }), 502)
    }

    // Trust on first use: the first account this container ever syncs is the
    // account it stays bound to. Being self-closing is not on its own what
    // stops a LAN neighbour re-pointing the sync -- the page is legitimately
    // open for the whole of first boot and every session death, and /health
    // advertises exactly when. This is what makes that claim true afterwards.
    const known = before.state.accountId
    if (known && session.accountId && session.accountId !== known) {
      deps.auth.restore(before)
      console.log('[setup] refused a link for a different bingers account')
      return c.html(setupPage({
        error: 'That link is for a different Bingers account than the one this container already '
          + 'syncs. Paste a link for the original account. (To move the sync to another account '
          + 'on purpose, stop the container and delete the database under /data.)',
      }), 403)
    }

    // The session works and is the right one, so writing may resume: the outbox
    // drains on its next tick.
    if (deps.gate.halted) { deps.gate.clear(); console.log('[setup] session acquired, resuming writes') }

    // The boot pull returned immediately because there was no session, so the
    // mirror has never synced and backfill stays suppressed until the next
    // scheduled pull -- up to SYNC_PULL_INTERVAL_MIN after a setup that just
    // succeeded. Episodes watched inside that window lose their backfill for
    // good, since nothing revisits them once the mirror goes fresh.
    try { await pullOnce(syncDeps(deps)) } catch (e) {
      console.log(`[setup] first pull after setup failed -> ${(e as Error).message}`)
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

export type BootSteps = {
  listen: () => void
  pull: () => Promise<void>
  beat: () => Promise<void>
  reverse: () => Promise<void>
  ratings: () => Promise<void>
  flush: () => Promise<void>
  pullIntervalMin: number
  schedule?: (fn: () => void, ms: number) => void
}

/**
 * Start listening FIRST, then do the boot-time reconcile.
 *
 * pull(), beat() and reverse() all talk to third parties, and reverse() is up
 * to REVERSE_BATCH x 7 sequential requests to plex discover. Awaiting any of
 * them before serve() means that while a third party is merely slow, the port
 * is closed: every Plex `media.scrobble` gets connection-refused instead of the
 * 200 the forward path depends on, and Plex does not replay them. The listener
 * has to be up within a second of start no matter what any remote host is
 * doing, so the boot reconcile runs behind an already-open socket.
 */
export async function boot(s: BootSteps): Promise<void> {
  s.listen()
  const schedule = s.schedule ?? ((fn, ms) => { setInterval(fn, ms) })
  // Registered before the first reconcile is awaited too, for the same reason:
  // a hung boot pull must not also mean nothing is ever scheduled.
  // The pull -> reverse -> ratings chain is sequential and unbounded: ratings
  // alone walks every library section and every rated bingers entry, which can
  // outlast a 30-minute interval on a large library. Two overlapping chains
  // would not merely duplicate work -- they interleave outbox writes and
  // sync_state mirrors for the same entities, which is precisely the
  // half-updated local state RR1's transaction exists to prevent. A tick that
  // arrives while the previous one is still running is SKIPPED, not queued:
  // the next tick does the same work anyway.
  let chainInFlight = false
  schedule(() => {
    if (chainInFlight) { console.log('[sync] previous cycle still running, skipping this tick'); return }
    chainInFlight = true
    void (async () => {
      try { await s.pull(); await s.reverse(); await s.ratings() } finally { chainInFlight = false }
    })()
  }, s.pullIntervalMin * 60_000)
  schedule(() => { void s.beat() }, 24 * 60 * 60_000)
  schedule(() => { void s.flush() }, 60_000)

  await s.pull(); await s.beat(); await s.reverse(); await s.ratings()
}

async function main() {
  const config = loadConfig(process.env)
  const store = openStore(config.dbPath)
  const auth = createAuth(store, config.bingersCookie, config.bingersUserAgent)
  const gate = createGate()
  // Declared before `deps` so the /health getter below closes over the same
  // binding that `ratings()` reassigns after each run -- a snapshot taken at
  // wiring time would freeze at null forever.
  let lastRatingRun: { at: string; fromPlex: RatingSyncResult; toPlex: RatingToPlexResult } | null = null
  const deps: AppDeps = { config, store, auth, gate, lastRatingRun: () => lastRatingRun }
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
  const reverse = async () => {
    try {
      const r = await reconcileWatchlist({ config, store })
      if (r.added || r.unresolved || r.deferred) {
        console.log(`[reverse] added ${r.added}, unresolved ${r.unresolved}, deferred ${r.deferred}`)
      }
    } catch (e) { console.error('[reverse]', (e as Error).message) }
  }
  // fromPlex runs BEFORE toPlex and the order is load-bearing: fromPlex writes
  // the rating_link rows carrying origin 'plex', and toPlex reads exactly those
  // to decide what it must refuse to write back. Reversed, the first run of a
  // newly-rated item would write back before the link exists.
  const ratings = async () => {
    if (!config.ratingSync) return
    try {
      const rd = { config, store, auth, gate }
      const fromPlex = await syncRatingsFromPlex(rd)
      const toPlex = await syncRatingsToPlex(rd)
      lastRatingRun = { at: new Date().toISOString(), fromPlex, toPlex }
      const busy = Object.values(fromPlex).some(n => n > 0) || Object.values(toPlex).some(n => n > 0)
      if (busy) {
        console.log(
          `[ratings] plex->bingers synced ${fromPlex.synced} unsupported ${fromPlex.unsupported}`
          + ` unresolved ${fromPlex.unresolved} ignored ${fromPlex.ignored} failed ${fromPlex.failed}`
          + ` | bingers->plex written ${toPlex.written}`
          + ` refused-origin ${toPlex.refusedOrigin} refused-halfstar ${toPlex.refusedHalfStar}`
          + ` skipped ${toPlex.skipped} unmapped ${toPlex.unmapped} failed ${toPlex.failed}`)
      }
    } catch (e) { console.error('[ratings]', (e as Error).message) }
  }

  await boot({
    listen: () => {
      serve({ fetch: createApp(deps).fetch, port: config.port })
      console.log(`bingers-sync on :${config.port} (DRY_RUN=${config.dryRun}, REVERSE_SYNC=${config.reverseSync}, RATING_SYNC=${config.ratingSync})`)
    },
    pull, beat, reverse, ratings, flush, pullIntervalMin: config.syncPullIntervalMin,
  })
}

if (process.argv[1]?.endsWith('server.js') || process.argv[1]?.endsWith('server.ts')) void main()
