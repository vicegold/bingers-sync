# bingers-sync

Mirrors Plex scrobbles and Pulsarr watchlist changes into Bingers.

## Setup

Everything is configured in `docker-compose.yml`. There is no `.env` file, and
nothing to copy or template first.

1. **Edit `docker-compose.yml`.** Fill in `PLEX_URL`, `PLEX_TOKEN` and
   `ALLOWED_USER` at the top of the `environment:` block. Every other setting is
   listed there too, commented out and showing its default, so that file is the
   whole reference for what is configurable — there is nowhere else to look.

   Two that matter: `DRY_RUN=true` is the default and means every intended write
   is logged and nothing is sent, and `DB_PATH` must stay under `/data` (the bind
   mount) or the outbox will not survive a restart.

2. **`docker compose up -d`.** This pulls `ghcr.io/vicegold/bingers-sync:latest`,
   which CI publishes on every push to main. To build from source instead:
   `docker compose --profile dev up -d --build bingers-sync-dev`

3. **Open `http://<host-ip>:8787/setup` and connect to Bingers.** In the Bingers
   app, request a magic link, then **copy the link out of the email instead of
   tapping it** — the token works exactly once, so opening it on your phone spends
   it before it reaches the container — and paste it into the page. The page
   trades it for a session and stores it under `/data`.

   `/setup` is self-closing: it answers only while there is no working session and
   404s the rest of the time, and it reopens by itself when the session expires or
   starts being rejected. `setupRequired` in `/health` says which it currently is.

   It is not, however, closed during first boot — it cannot be, since that is when
   you use it — so the port is worth keeping off any untrusted network. What
   protects it afterwards is that the first session it stores fixes the Bingers
   account this container syncs: a link for any other account is refused, so a
   neighbour cannot re-point the sync at their own even while the page is open. To
   move the sync to a different account on purpose, stop the container and delete
   the database under `/data`.

4. **Point Plex and Pulsarr at the service.** Use the host's **IP**, not a hostname:

   | Webhook | URL |
   |---|---|
   | Plex (app.plex.tv → Settings → Webhooks, needs Plex Pass) | `http://<host-ip>:8787/plex` |
   | Pulsarr | `http://<host-ip>:8787/pulsarr` |

   Plex has no per-event filter and sends all ~12 event types; everything except
   `media.scrobble` is logged and discarded. Do not use `localhost` even when
   everything is on one box — if Plex or Pulsarr runs in Docker, `localhost` is
   that container, not the host.

### Running it off-host (e.g. from a Mac)

The service must reach Plex's API outbound. On macOS 15+, Local Network privacy
blocks LAN access per-process: `curl` is Apple-signed and exempt, but Node is
not, so the Plex lookup fails with `EHOSTUNREACH` while `curl` to the same
address succeeds. Grant Local Network access to the terminal app, or run the
service on the same host as Plex.

`DRY_RUN=true` is the default: every intended write is logged and nothing is sent.
Verify the log looks right, then set `DRY_RUN=false` and restart.

## Operating

- `GET /setup` — connect to Bingers, as in step 4. Only reachable while there is
  no working session; `setupRequired` in `/health` says whether it is open.
- `GET /health` — dry-run state, days left on the session, whether writes are
  halted, outbox depth, and mirror freshness (`backfillEnabled` is false when the
  local mirror is stale, which suppresses backfill but not the scrobble itself).
  `abandonedOps` counts writes this service has **given up** delivering after
  Bingers refused them repeatedly — a dropped user write, never silent, with the
  payload to replay by hand in the matching `failures` row. A non-zero value
  there wants looking at.
- Every inbound webhook is logged with its event type, account and outcome —
  including ones that are ignored, so "nothing happened" is distinguishable from
  "never arrived".
- Unresolvable events land in the `failures` table with their payload, and still
  return HTTP 200 so Plex does not retry them.
- The session cannot be renewed programmatically: requesting a magic link is
  behind a Cloudflare Turnstile check that only the app can pass, so the
  container can redeem a link but never ask for one. If `sessionDaysRemaining`
  starts falling toward zero, if a 401 halts writes, or if the session simply
  runs out, open `/setup` again and paste a fresh link — it reopens on its own
  in all three cases. No restart, and nothing to edit in `docker-compose.yml`.

  `/setup` verifies the session before it trusts it: a link that is rejected, or
  that returns a session which cannot then look itself up, leaves the container
  on whatever it had rather than on a half-adopted one. So a red page there
  means nothing changed, and a green one means the new session actually works.

- Until a session exists, nothing is lost and nothing cries wolf: writes queue in
  the outbox instead of being sent with an empty cookie, so an unconfigured
  container does not report itself as a broken one. They drain on the next flush
  after `/setup` succeeds.
- Following a title on Bingers adds it to your Plex watchlist, which Pulsarr then
  routes to Sonarr/Radarr. A title is only added when Plex Discover returns an
  item whose tmdb/tvdb/imdb IDs match the Bingers title — Discover has no
  search-by-ID, so an unverifiable title is reported in `failures` rather than
  guessed at. This is **off by default**: set `REVERSE_SYNC=true` (that exact
  string; anything else is off) to turn it on. Be aware that the first run adds
  every Bingers follow that is not already linked, which for a long follow
  history means a large batch of download requests — `REVERSE_BATCH` limits how
  many are reconciled per pull.
- With `RATING_SYNC=true`, episode and movie ratings sync both ways. Plex stores
  half-stars (0–10) and Bingers whole stars (1–5), so a rating you set in Plex is
  mirrored into Bingers and, while you leave it alone in Bingers, never written
  back — that would round 4.5 stars to 4 or 5 permanently. Change that rating in
  Bingers and it *is* written to Plex: the refusal covers "Plex authored this and
  you have not touched it since", not "Plex once authored this". Clearing a rating
  in Plex is likewise not undone by the Bingers value it produced. Show ratings
  have no Bingers equivalent and are recorded once in `failures`; season ratings
  are not polled at all, for the same reason. An item Bingers' catalogue genuinely
  does not have is also recorded once and then skipped, so it cannot hold that
  section's cursor — and everything rated after it — back forever.
  A Bingers rating is **not** written to Plex when Plex's current value already
  rounds to it. Rating 5 in Bingers against 9 in Plex (4.5 stars) writes nothing:
  `bingersToPlex(5)` is 10, which would destroy the half-star. These appear as
  `refused-halfstar` in the `[ratings]` log line, and separately from
  `refused-origin` on `/health`, because a steady state and a caught data loss
  are not the same event: the half-star refusals are logged per item, while the
  "Plex authored it, unchanged since" ones get a single summary line. A rating
  you change in Bingers is **deferred**, not lost, while an unconfirmed write
  for that item is still sitting in the outbox — if Bingers was unreachable, the
  change appears not to sync until the outbox drains, then goes through on the
  next cycle. An item Bingers' catalogue does not have is re-checked after
  `UNRATABLE_RECHECK_HOURS` (default a week), since the catalogue keeps growing;
  a show rating is never re-checked, because that one will not change. Episode ratings need the show's
  local Plex `ratingKey`, which is captured from scrobbles. A show never
  scrobbled since enabling this reports its episodes as `unmapped` until it is.
