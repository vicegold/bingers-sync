# bingers-sync — design

**Date:** 2026-09-16
**Status:** approved, pending implementation plan

## Purpose

Mirror watch activity and watchlist changes into [Bingers](https://bingers.app),
which has no public API, by consuming two webhooks that already exist on the
local network:

- **Plex** `media.scrobble` → mark the episode or movie watched on Bingers
- **Pulsarr** `watchlist.added` / `watchlist.removed` → follow / unfollow on Bingers

Both are filtered to the single user `plexuser`. Everything else is ignored.

## Constraints

- Bingers' API is private and undocumented. It can change without notice; the
  service is expected to need occasional repair.
- Every mapping between an external ID and a Bingers ID must be **verified**
  before anything is written. No title-similarity guessing.
- Request volume against Bingers must stay low. The local cache, not politeness
  in the request loop, is what achieves this.
- The only write credential is a session cookie obtained by capturing the app's
  traffic. It cannot be minted programmatically.

## Protocol reference

Derived from two Proxyman captures of Bingers iOS `0.2.0+55` plus direct probing
of the public endpoints. Marked **verified** where observed in traffic or
reproduced directly, **assumed** where inferred.

### Public, no authentication

Confirmed by request with no cookie, returning 200.

```
GET https://api.bingers.app/search/titles?q={query}&page=0&lang=de
→ { results: [ { id, kind, metadata, card: { originalTitle, originalLanguage,
                                              titlesI18n, posterRef, year } } ] }

GET https://catalog.bingers.app/catalog/{titleId}/versions.json
→ { titleId, kind, files: { metadata, credits, images, similar, videos,
                            "watch-providers",
                            metadataByLang: { <lang>: hash },
                            seasons: { "<n>": hash },
                            seasonsByLang: { <lang>: { "<n>": hash } } } }

GET https://catalog.bingers.app/catalog/{titleId}/metadata@{hash}.json
→ { id, title, original_title, year, kind, seasons: [...], status,
    external_ids: [ { id, source, type, url } ] }
    # source ∈ imdb | tmdb | tvdb | tv maze | wikidata | wikipedia | ...

GET https://catalog.bingers.app/catalog/{titleId}/season-{n}@{hash}.json
→ { episodes: [ { n, abs, id, title, overview, aired, air_utc, runtime, img } ] }

GET https://catalog.bingers.app/explore/v1/generations/{ts}/{show|movie}/{popular|trending}/{lang}.json
→ { generatedAt, generation, kind, list, locale, schemaVersion,
    items: [ { id, title, year, metadata, provider: { id, source, type }, ... } ] }   # 2000 items
```

The `{kind}@{hash}.json` path convention is the key to the whole catalog. Hashes
come from `versions.json` and change when Bingers re-publishes a title.

The explore generations are the only bulk listing, and they do carry an external
ID inline via `provider`. They are **not** a usable reverse index: 2000 popular
titles is not the catalog, and `titleId` is a UUIDv7, so the ID space cannot be
enumerated. Resolution is therefore on-demand plus cache.

### Authenticated

Single credential, no CSRF token:

```
Cookie: __Secure-better-auth.session_token=<token>
```

```
GET  /sync/pull?follows={cursor}&entries={cursor}&catalog={cursor}&prefs={cursor}
                &settings={cursor}&notifKinds=2&titlesLang=de&trigger={trigger}
→ { imports, follows[], entries[], lists[], listItems[], catalog[],
    prefs[], settings[], notifications[], entriesTotal, cursors{} }

POST /sync/push
  { clientBatchId: uuid, ops: [ { opId: uuid, table, pk, fields } ] }
→ { results: [ { opId, status: "applied" } ], rows: { ... } }
```

Cursors are plain ISO timestamps except `entries`, which is compound:
`{iso}~{entityKind}~{entityId}`, e.g.
`2026-09-16T09:22:30.211000Z~episode~019f6bb0-1f99-7645-bdac-64c4d84149df`.

`trigger` is a free-form label; values observed are `boot`, `foreground`,
`follow` and `follow-synced`.

### Push op shapes — verified

Both captured from real traffic. **The client sends flags, not timestamps; the
server stamps the times.**

```jsonc
// follow a title (observed when adding a show to the watchlist)
{ "opId": "<uuid>", "table": "follows",
  "pk": { "titleId": "019f6bb9-65cf-78d1-b123-f9ed891fe9d7" },
  "fields": { "kind": "show", "forLater": false,
              "stopped": false, "watchlistHidden": false } }

// mark an episode watched
{ "opId": "<uuid>", "table": "entries",
  "pk": { "entityKind": "episode", "entityId": "019f6bb9-65fd-7ef3-8053-8e3333a9f117" },
  "fields": { "watched": true, "plays": 1, "batchId": null } }
```

### Batches — verified

Capture 4 is the app's own "mark previous episodes as watched" flow. It sends
**one** `sync/push` containing N `entries` ops that share a single
client-generated `batchId`:

```jsonc
{ "clientBatchId": "f8d4617b-…",          // per-request, idempotency
  "ops": [
    { "opId": "7cf7e9de-…", "table": "entries",
      "pk": { "entityKind": "episode", "entityId": "019f6bb8-02e7-7361-…" },
      "fields": { "watched": true, "plays": 1,
                  "batchId": "278c0da3-…" } },   // shared across the group
    { "opId": "e3f0678b-…", … "batchId": "278c0da3-…" },
    { "opId": "e755100d-…", … "batchId": "278c0da3-…" }
  ] }
```

The two IDs are distinct in purpose: `clientBatchId` scopes the HTTP request,
`batchId` is a semantic grouping persisted on every resulting row. All ops
returned `status: "applied"`, and all three rows came back stamped with the
*same* `firstWatchedAt`. Op order in the array does not matter — the captured
ops were E5, E7, E6.

The app sends no `PATCH` after a batch, so its own catch-up leaves every episode
dated to the moment you tapped the button.

Note what is *absent*: no `followedAt`, no `firstWatchedAt`, no `lastWatchedAt`.
The `sync/push` response for the entries op returns the stored row with
`firstWatchedAt` and `lastWatchedAt` both set to server receipt time. The push
fields are booleans (`forLater`, `stopped`, `watchlistHidden`) where the pull rows
carry timestamps (`forLaterAt`, `stoppedWatchingAt`, `watchlistHiddenAt`) — the
server converts.

The entry's `firstWatchedAt` / `lastWatchedAt` are **derived** from individual
watch records, and `plays` is the count of them. To set a real watch date, edit
the record — see below.

### Watch records — verified

```
GET   /me/watches?entityKind={kind}&entityId={id}
→ { watches: [ { id, watchedAt } ] }

PATCH /me/watches/{watchId}
  { watchedAt, entityKind, entityId }
→ { entry: { ..., firstWatchedAt, lastWatchedAt, updatedAt } }
```

Captured backdating an episode from the server-stamped `2026-09-16T10:40:47.414Z`
to `2026-09-11T10:40:47.414Z`; the response confirms both `firstWatchedAt` and
`lastWatchedAt` on the entry moved with it.

**Watch times therefore can be backdated**, in three steps: push the entry, read
back the watch record to get its `id`, then PATCH it. Cost is two extra requests
per episode beyond the push.

Not yet probed, and worth one attempt during implementation: whether
`POST /me/watches` accepts `{ entityKind, entityId, watchedAt }` directly. If it
does, a dated watch becomes a single request and the push/read/patch dance is
unnecessary. `DELETE /me/watches/{id}` presumably exists too, for correcting a
mistaken scrobble.

Row shapes observed in `sync/pull`:

```
follows: { titleId, kind, isFavorite, favoritePosition, preferredPosterKey,
           preferredBackdropKey, preferredLogoKey, forLaterAt, stoppedWatchingAt,
           watchlistHiddenAt, backfillOptOut, followedAt, updatedAt, deletedAt }

entries: { entityKind, entityId, watched, plays, firstWatchedAt, lastWatchedAt,
           rating, feeling, favoritePersonId, favoriteCharacterId, batchId,
           updatedAt, deletedAt }
```

Other routes seen but unused here: `GET /me`, `/me/following`,
`/me/follow-requests`, `/me/follows/rails`, `/stats/titles/{titleId}`,
`PUT /devices`.

### Realtime

There is none. Neither capture contains an `Upgrade:` header,
`Sec-WebSocket-*`, a `101 Switching Protocols`, a `text/event-stream`, or any
`ws://`/`wss://` URL, and only two hosts are ever contacted (`api` and
`catalog`). Sync is strictly poll-driven, triggered on app lifecycle and user
action. Out-of-band delivery to the app is APNs push via Expo, registered with
`PUT /devices` and surfaced through `notifKinds` — not a data channel.

### Verified vs assumed

| Item | Status |
|---|---|
| `search/titles` is public | **verified** — 200 with no cookie |
| Catalog paths and shapes above | **verified** — fetched directly |
| `entries` push op for an episode | **verified** — observed in both captures |
| `follows` push op | **verified** — observed in capture 2 |
| Server stamps watch/follow times; client sends flags | **verified** — push body vs. returned row |
| `sync/pull` row shapes and cursor formats | **verified** — observed in capture |
| Cookie auth, no CSRF | **verified** — observed in capture |
| No websocket/SSE channel exists | **verified** — absent from both captures |
| `GET`/`PATCH /me/watches` backdating flow | **verified** — observed in capture 3 |
| `entityKind: "movie"` exists in entries | **verified** — seen in an entries cursor |
| Movie `entityId` = titleId | **assumed** |
| Unfollow shape (likely `fields: { deleted: true }`) | **assumed** |
| Batched entries ops sharing a `batchId` | **verified** — observed in capture 4 |
| `POST /me/watches` for one-step dated writes | **untested** — probe once |
| `GET /me/watches?batchId=` for bulk read-back | **untested** — probe once |
| Session `expiresAt` slides forward on use | **assumed** — see Auth |

The remaining assumed write shapes are why the service ships with `DRY_RUN=true`.

## Architecture

Node + TypeScript (Hono) in Docker on FC10, SQLite on a mounted volume.
Plex and Pulsarr are both on the local network, so the service listens on plain
HTTP with no public exposure.

```
Plex ──multipart/form-data──┐
                            ├─→ filter(plexuser) ─→ resolve() ─→ plan() ─→ push()
Pulsarr ──application/json──┘         │                │                    │
                                      │                │                    ↓
                                      │                └── SQLite ──→ api.bingers.app
                                      └── plex API + catalog.bingers.app
```

```
src/
  server.ts              Hono app, two routes, health
  routes/plex.ts         media.scrobble  (multipart)
  routes/pulsarr.ts      watchlist.added / .removed  (json)
  plex/client.ts         show guid lookup by ratingKey
  bingers/search.ts      search/titles
  bingers/catalog.ts     versions.json, metadata@, season-@
  bingers/sync.ts        sync/pull, sync/push
  bingers/auth.ts        cookie jar, heartbeat, expiry tracking
  resolve.ts             external ids → titleId / episodeId
  plan.ts                events → ops (follow, watched, backfill)
  store.ts               SQLite
  notify.ts              failure notifications
```

### Module boundaries

`resolve.ts` is the only module that maps external identity to Bingers identity,
and it returns either a verified ID or a failure — never a guess. `plan.ts` turns
a resolved event into a list of ops without performing I/O, which makes the
behavioural rules (auto-follow, backfill, specials exclusion) testable in
isolation. `bingers/sync.ts` is the only module that writes.

## Resolution

Both sources converge on a set of **show-level** external IDs, then take the same
path.

```
Plex episode:
  Metadata.grandparentRatingKey
    → GET {PLEX_URL}/library/metadata/{key}?includeGuids=1   (X-Plex-Token)
    → Guid[] → { tmdb, tvdb, imdb } for the SHOW

Plex movie:
  Metadata.Guid[] is already movie-level → use directly

Pulsarr:
  data.content.guids → { tmdb, tvdb, imdb } directly
```

The Plex callback is necessary because a `media.scrobble` payload's `Guid[]`
identifies the **episode**, not the show. In the reference payload, the episode
carries `tmdb://5175711` while the show *Tires* is `tmdb 247522`. Bingers season
files key episodes by position with no external IDs of their own, so the episode
GUIDs are unusable for matching at either level.

Then:

```
1. cache hit on (source, ext_id)?            → titleId, done
2. GET search/titles?q={title}
3. for each result where kind matches:
     GET catalog/{id}/metadata@{metadata}.json
     if external_ids ∩ our guids ≠ ∅        → titleId, verified
4. no intersection after SEARCH_MAX_PAGES     → failure
```

Search is by text but the **decision is by ID intersection**, so a localised or
mistyped title costs at most a wasted search, never a wrong write.

### Episode resolution and the cache

On first resolution of a show, the service fetches `versions.json` and then
**every** season file, storing the complete episode map in one pass. Subsequent
episodes of that show resolve from SQLite with no network calls at all.

A cache miss on `(titleId, season, number)` — a newly aired episode — triggers a
re-fetch of `versions.json`; any season whose hash changed is re-fetched and
upserted. `versions.json` is also re-checked on a TTL (default 24h) for followed
shows.

## Storage

```sql
CREATE TABLE title_map (               -- external identity → bingers identity
  source      TEXT NOT NULL,           -- 'tmdb' | 'tvdb' | 'imdb'
  ext_id      TEXT NOT NULL,
  kind        TEXT NOT NULL,           -- 'show' | 'movie'
  title_id    TEXT NOT NULL,
  title       TEXT,
  year        INTEGER,
  verified_at TEXT NOT NULL,
  PRIMARY KEY (source, ext_id, kind)
);
CREATE INDEX title_map_title_id ON title_map (title_id);

CREATE TABLE episode_map (             -- (show, season, number) → bingers episode
  title_id    TEXT NOT NULL,
  season      INTEGER NOT NULL,
  number      INTEGER NOT NULL,
  episode_id  TEXT NOT NULL,
  abs         INTEGER,
  title       TEXT,
  aired       TEXT,
  season_hash TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (title_id, season, number)
);
CREATE INDEX episode_map_episode_id ON episode_map (episode_id);

CREATE TABLE catalog_version (         -- last seen versions.json per title
  title_id   TEXT PRIMARY KEY,
  files_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);

CREATE TABLE sync_state (              -- local mirror from sync/pull
  table_name TEXT NOT NULL,            -- 'follows' | 'entries'
  pk         TEXT NOT NULL,            -- titleId, or entityKind:entityId
  row_json   TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (table_name, pk)
);

CREATE TABLE cursors (name TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE outbox (                  -- pending / retrying ops
  op_id       TEXT PRIMARY KEY,
  batch_id    TEXT,
  table_name  TEXT NOT NULL,
  pk_json     TEXT NOT NULL,
  fields_json TEXT NOT NULL,
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_try_at TEXT,
  status      TEXT NOT NULL,           -- 'pending' | 'applied' | 'failed'
  created_at  TEXT NOT NULL
);

CREATE TABLE failures (                -- unresolvable events, for manual review
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  source      TEXT NOT NULL,           -- 'plex' | 'pulsarr'
  reason      TEXT NOT NULL,
  payload     TEXT NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE TABLE auth_state (              -- session token + observed expiry history
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  cookie      TEXT NOT NULL,
  expires_at  TEXT,
  rotated_at  TEXT,
  checked_at  TEXT
);
```

`title_map` holds one row per external ID per title, so a show resolved via TMDB
is also found later via TVDB or IMDb without re-searching.

## Behaviour

### Plex `media.scrobble`

Plex posts `multipart/form-data` with the JSON in a `payload` part — not a JSON
body. Accepted only when `Account.title === "plexuser"`.

1. Resolve show (episodes) or movie IDs as above.
2. If the title is not in `follows`, emit a `follows` op first.
3. Emit an `entries` op: `entityKind: "episode"` with the resolved `episodeId`, or
   `entityKind: "movie"` with the `titleId`. `plays` = `Metadata.viewCount` or 1.
4. Backfill (episodes only) — see below.
5. Push every op as one batch.
6. Date correction: for each entry written, `GET /me/watches` and `PATCH` the
   record to that episode's own real watch time.

Step 6 is skipped for any entry whose corrected time is already within
`WATCH_DATE_TOLERANCE_SEC` of the server stamp, so a live scrobble stays at one
request.

### Backfill

Backfill mirrors Plex's actual watch history rather than inferring one from
position. Plex already knows when each episode was watched and how often:

```
GET {PLEX_URL}/library/metadata/{grandparentRatingKey}/allLeaves   (X-Plex-Token)
→ every episode of the show with parentIndex, index, viewCount, lastViewedAt
```

For each episode where `viewCount > 0`:

- map `(parentIndex, index)` → `episodeId` via `episode_map` (cached, no catalog I/O)
- **skip it if `sync_state` already has it watched on Bingers** — backfill only
  ever writes episodes Bingers does not already know about
- emit an `entries` op with that episode's own `viewCount` as `plays`
- tag every op in the run with one shared `batchId`, matching the app's own
  catch-up flow, so Bingers groups it as a single action
- correct its date to that episode's own `lastViewedAt` in step 6

All ops go in **one** `sync/push`, as the app does. This service then goes one
step further than the app, which leaves batch-marked episodes dated to the moment
you tapped the button: each entry is dated to its real Plex watch time.

Because every backfilled watch now carries a genuine Plex timestamp, there is no
invented date and no `BACKFILL_DATE_MODE` policy to choose.

**Season 0 is no longer excluded.** That exclusion existed only because the
earlier design inferred watches by position, where sweeping up specials would
have been wrong. Mirroring real Plex view state removes the problem: a special is
written if and only if Plex recorded you watching it.

`allLeaves` is fetched at most once per show per `PLEX_ALLLEAVES_TTL_MIN`, and
skipped entirely for shows already fully reconciled, so the steady state for a
show you watch weekly is no extra Plex calls at all.

### Pulsarr `watchlist.added` / `watchlist.removed`

JSON body. Accepted only when `data.addedBy.username === "plexuser"`.

- `added` → `follows` op with `fields: { kind, forLater: false, stopped: false,
  watchlistHidden: false }` (verified shape)
- `removed` → `follows` op soft-deleting the row; exact field name unverified,
  most likely `{ deleted: true }` by analogy with the flag/timestamp split. Confirm
  before enabling.

### Local mirror

`sync/pull` runs at boot and every `SYNC_PULL_INTERVAL_MIN`, using stored cursors
so each run is incremental. It populates `sync_state`, which is what the
auto-follow check, the backfill "already watched" filter and idempotency all read
from — none of them query Bingers per event.

### Idempotency

Keyed on `(entityKind, entityId)` against `sync_state`. A repeat scrobble of an
already-watched episode updates `lastWatchedAt` and `plays` rather than creating a
duplicate. `opId` and `clientBatchId` are fresh UUIDs per push.

### Failure handling

| Case | Response |
|---|---|
| Unresolvable / unverified | row in `failures`, notification, **HTTP 200** |
| Bingers 5xx, network error | `outbox` retry with exponential backoff |
| Bingers 401 | stop writing, keep queueing, notify |
| Wrong user, other event types | ignore, HTTP 200 |

HTTP 200 on unresolvable events is deliberate: Plex retries on non-2xx, and
retrying something that will never resolve only generates noise.

## Auth lifecycle

`__Secure-better-auth.session_token` is the only write credential, obtained by
capturing app traffic. Observed session: created `2026-09-16T08:20:14Z`, expires
`2027-09-16T08:20:14Z` — exactly 365 days, against better-auth's 7-day default,
so the long window is deliberate.

Route probing (no credentials sent):

| Route | Result | Meaning |
|---|---|---|
| `POST /auth/refresh-token` | 400, requires `providerId` | refreshes the **Apple** OAuth token, not the session — not usable |
| `GET /auth/token` | 401 | bearer/JWT plugin exists, mints from a session |
| `GET /auth/list-sessions` | 401 | exists, exposes `expiresAt` |
| `GET /auth/get-session` | 200 | what the app calls |

There is no session refresh token. better-auth instead uses a rolling session:
once `updateAge` elapses, the next authenticated request slides `expiresAt`
forward and re-issues the cookie. Neither capture is old enough to show a
rotation — both are within ~2h of session creation — so this is inference, not
observation. The only `Set-Cookie` seen is `session_data` with `Max-Age=300`,
which is better-auth's 5-minute cache, not a credential.

The design does not depend on which case is true:

1. **Persistent cookie jar** — every response is inspected for a `session_token`
   `Set-Cookie`; a rotation is written back to `auth_state` immediately.
2. **Daily heartbeat** — `GET /auth/get-session?disableCookieCache=true`, which is
   what triggers the sliding refresh, recording `session.expiresAt`.
3. **Expiry monitoring** — warn at 30 days remaining.

This self-verifies within a day or two of running: if the recorded `expires_at`
moves, the session is rolling and needs no further attention; if it stays pinned,
it is a fixed annual session and the warning gives a month's notice. Worst case is
one manual re-capture per year.

`GET /auth/token` should be tried once with a live session during implementation.
If it yields a usable bearer token, `Authorization: Bearer` is a cleaner transport
than replaying a browser cookie — but such tokens are typically shorter-lived than
the session, so this is a possible refinement, not a dependency.

## Configuration

```
BINGERS_SESSION_COOKIE=    # __Secure-better-auth.session_token value
PLEX_URL=                  # http://plex.local:32400
PLEX_TOKEN=
ALLOWED_USER=plexuser      # Plex Account.title and Pulsarr addedBy.username
DRY_RUN=true               # default; log intended pushes without sending
PORT=8787
DB_PATH=/data/bingers-sync.db
CATALOG_TTL_HOURS=24
WATCH_DATE_TOLERANCE_SEC=120 # skip the PATCH when server stamp is already close enough
PLEX_ALLLEAVES_TTL_MIN=60    # how often a show's Plex watch state may be re-read
SEARCH_MAX_PAGES=3         # search/titles pages scanned before declaring failure
SYNC_PULL_INTERVAL_MIN=30  # refresh of the local follows/entries mirror
NOTIFY_URL=                # webhook for failure notifications
```

## Testing

- **resolve.ts** — fixtures from both real captures plus the two reference
  payloads. Cases: exact ID match; multiple candidates where only one intersects;
  zero intersection → failure; cache hit avoids all network calls.
- **plan.ts** — pure function over (event, Plex watch state, sync_state), no I/O.
  Cases: unfollowed show emits follow first; backfill emits only episodes Plex
  marks watched; an episode already watched on Bingers is never re-written; each
  backfilled op carries that episode's own `lastViewedAt` and `viewCount`; a Plex
  special with `viewCount > 0` is included; an episode Plex has never played is
  not written even when later episodes were.
- **Webhook parsing** — Plex multipart with a real captured body; Pulsarr JSON;
  both rejected for a user other than `plexuser`.
- **Auth** — cookie rotation is persisted; 401 halts writes without dropping
  queued ops.
- Bingers HTTP is stubbed in tests. No test touches the live API.

## Rollout

1. Capture one "add to watchlist" action in the app to confirm the `follows` push
   op shape. Correct the spec if it differs.
2. Run with `DRY_RUN=true` and replay both reference payloads; confirm the planned
   ops are correct.
3. Flip `DRY_RUN=false` for a single known episode; verify in the app.
4. Point the real Plex and Pulsarr webhooks at the service.

## Reverse sync: Bingers → Plex

Bingers has no realtime channel, so this is the existing `sync/pull` mirror doing
double duty. Each poll already returns new `follows` rows; reverse sync acts on
the ones this service did not originate.

```
sync/pull → new follows[] row
  ↓  titleId → title_map (already cached, no catalog fetch)
tvdb / tmdb id
  ↓
add to Plex watchlist
  ↓
Pulsarr's watchlist.added fires as it does today
  ↓
Sonarr / Radarr, routed by Pulsarr's own rules
```

Going through the Plex watchlist rather than calling Sonarr directly keeps
quality profile, root folder and season monitoring in Pulsarr, where they already
live, instead of duplicating them here.

The exact Plex Discover endpoint for adding to a watchlist is **not yet
verified** — it needs a Discover `ratingKey`, which is not the local library
`ratingKey`, so a lookup by GUID is required first. This must be confirmed
against the live Plex API during implementation before the path is enabled.

### Loop prevention

The cycle Bingers follow → Plex watchlist → Pulsarr webhook → Bingers follow
terminates on its own: by the time Pulsarr's event arrives the title is already
in `sync_state` as followed, so the forward path treats it as a no-op. Titles
pushed outward are additionally recorded in `outbox` so the no-op is explicit
rather than incidental.

## Out of scope

Ratings and feelings; lists beyond the watchlist; multi-user support; any UI.
