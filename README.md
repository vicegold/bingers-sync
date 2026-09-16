# bingers-sync

Mirrors Plex scrobbles and Pulsarr watchlist changes into Bingers.

## Setup

1. `cp .env.example .env` and fill in `PLEX_URL`, `PLEX_TOKEN`, `ALLOWED_USER`.
   The Bingers session is **not** configured here — you get it from `/setup`
   in step 4, and it is stored in the database rather than in `.env`.
2. Log in to the registry once (the package is private):
   `echo <PAT-with-read:packages> | docker login ghcr.io -u vicegold --password-stdin`
3. `docker compose up -d` — pulls `ghcr.io/vicegold/bingers-sync:latest`, published
   by CI on every push to main. To build from source instead:
   `docker compose --profile dev up -d --build bingers-sync-dev`

   Every variable is listed under `environment:` in `docker-compose.yml`, so that
   file is the reference for what is configurable. Only the Plex secrets come
   from `.env`; the rest are set inline. `DB_PATH` must stay under `/data` — the
   bind mount — or the outbox will not survive a restart.
4. Open `http://<host-ip>:8787/setup` and connect to Bingers. In the Bingers
   app, request a magic link, then **copy the link out of the email instead of
   tapping it** — the token works exactly once, so opening it on your phone
   spends it before it reaches the container — and paste it into the page.
   The page trades it for a session and stores it under `/data`.

   `/setup` is self-closing: it answers only while there is no working session,
   and 404s the rest of the time, so a neighbour on your LAN cannot re-point the
   sync at their own account. It reopens by itself if the session ever dies.
5. Point Plex and Pulsarr at the service. Use the host's **IP**, not a hostname:

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
- Every inbound webhook is logged with its event type, account and outcome —
  including ones that are ignored, so "nothing happened" is distinguishable from
  "never arrived".
- Unresolvable events land in the `failures` table with their payload, and still
  return HTTP 200 so Plex does not retry them.
- The session cannot be renewed programmatically: requesting a magic link is
  behind a Cloudflare Turnstile check that only the app can pass, so the
  container can redeem a link but never ask for one. If `sessionDaysRemaining`
  starts falling toward zero, or a 401 halts writes, open `/setup` again — it
  reopens on its own in both cases — and paste a fresh link. No restart, and
  nothing to edit in `.env`.
