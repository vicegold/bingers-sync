# bingers-sync

Mirrors Plex scrobbles and Pulsarr watchlist changes into Bingers.

## Setup

1. `cp .env.example .env` and fill in `BINGERS_SESSION_COOKIE`, `PLEX_URL`, `PLEX_TOKEN`.
   The cookie is the `__Secure-better-auth.session_token` value, obtained by
   capturing the Bingers app's traffic with a TLS proxy.
2. `docker compose up -d --build`
3. Point Plex at `http://<host>:8787/plex` (Settings → Webhooks) and Pulsarr at
   `http://<host>:8787/pulsarr`.

`DRY_RUN=true` is the default: every intended write is logged and nothing is sent.
Verify the log looks right, then set `DRY_RUN=false` and restart.

## Operating

- `GET /health` — dry-run state, days left on the session, whether failures exist.
- Unresolvable events land in the `failures` table with their payload, and still
  return HTTP 200 so Plex does not retry them.
- The session cannot be refreshed programmatically. If `sessionDaysRemaining`
  starts falling toward zero, capture a fresh cookie and restart.

See `docs/superpowers/specs/2026-09-16-bingers-sync-design.md` for the reverse-engineered protocol.
