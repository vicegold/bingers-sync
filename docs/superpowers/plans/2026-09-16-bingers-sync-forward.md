# bingers-sync (forward path) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A webhook service that mirrors Plex scrobbles and Pulsarr watchlist changes into Bingers, matching titles by verified external ID and never by guesswork.

**Architecture:** Two webhook routes feed a pure planner. `resolve.ts` maps external IDs (tmdb/tvdb/imdb) to Bingers UUIDs via public search plus catalog metadata, caching every mapping in SQLite so repeat episodes cost no network. `plan.ts` turns a resolved event plus local state into a list of ops with no I/O, which makes every behavioural rule unit-testable. `bingers/sync.ts` is the only module that writes.

**Tech Stack:** Node 22, TypeScript (ESM), Hono, better-sqlite3, zod, vitest, Docker.

**Spec:** `docs/superpowers/specs/2026-09-16-bingers-sync-design.md`

## Global Constraints

- **Never write on an unverified match.** A Bingers title is only accepted when its `external_ids` intersect the incoming tmdb/tvdb/imdb IDs. No title-similarity fallback.
- **`DRY_RUN` defaults to `true`.** Every write path logs the intended request and returns without sending until explicitly disabled.
- **Only user `plexuser`.** Plex: `Account.title`. Pulsarr: `data.addedBy.username`. Anything else is ignored with HTTP 200.
- **Unresolvable events return HTTP 200**, are recorded in `failures`, and notify. Only transient errors retry.
- Bingers writes carry exactly `Cookie: __Secure-better-auth.session_token=<token>`. No CSRF token exists.
- Verified op shapes, to be used literally:
  - follows update — `{opId, table:'follows', pk:{titleId}, fields:{kind, forLater, stopped, watchlistHidden}}`
  - follows delete — `{opId, table:'follows', pk:{titleId}, deleted:true}` (**op-level `deleted`, no `fields` key**)
  - entries — `{opId, table:'entries', pk:{entityKind, entityId}, fields:{watched, plays, batchId}}`
- Timestamps are never sent in push `fields`; the server stamps them. Dates are corrected afterwards via `PATCH /me/watches/{id}`.
- Hosts: `https://api.bingers.app` (auth required except `/search/titles`), `https://catalog.bingers.app` (fully public).

---

### Task 1: Project scaffold, config, and fixtures

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.env.example`, `.gitignore`
- Create: `src/config.ts`
- Create: `tests/fixtures/*.json`
- Test: `tests/config.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces: `loadConfig(env: NodeJS.ProcessEnv): Config` where
  `Config = { bingersCookie: string; bingersUserAgent: string; plexUrl: string; plexToken: string; allowedUser: string; dryRun: boolean; port: number; dbPath: string; catalogTtlHours: number; searchMaxPages: number; syncPullIntervalMin: number; watchDateToleranceSec: number; plexAllLeavesTtlMin: number; notifyUrl: string | null }`

- [ ] **Step 1: Initialise the project**

```bash
cd /Users/laurids/DEV/bingers-sync/bingers-sync
npm init -y
npm pkg set type=module main=dist/server.js
npm pkg set scripts.build="tsc -p tsconfig.json"
npm pkg set scripts.test="vitest run"
npm pkg set scripts.dev="tsx watch src/server.ts"
npm i hono @hono/node-server better-sqlite3 zod
npm i -D typescript tsx vitest @types/node @types/better-sqlite3
```

- [ ] **Step 2: Add `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "outDir": "dist",
    "rootDir": "src",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 3: Add `vitest.config.ts` and `.gitignore`**

```ts
// vitest.config.ts
import { defineConfig } from 'vitest/config'
export default defineConfig({ test: { environment: 'node', include: ['tests/**/*.test.ts'] } })
```

```
# .gitignore
node_modules/
dist/
*.db
.env
```

- [ ] **Step 4: Write the failing config test**

```ts
// tests/config.test.ts
import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  BINGERS_SESSION_COOKIE: 'tok',
  PLEX_URL: 'http://plex.local:32400',
  PLEX_TOKEN: 'plex',
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv)
    expect(c.dryRun).toBe(true)
    expect(c.allowedUser).toBe('plexuser')
    expect(c.port).toBe(8787)
    expect(c.catalogTtlHours).toBe(24)
    expect(c.searchMaxPages).toBe(3)
    expect(c.watchDateToleranceSec).toBe(120)
  })

  it('only disables dry run for the exact string "false"', () => {
    expect(loadConfig({ ...base, DRY_RUN: 'false' } as NodeJS.ProcessEnv).dryRun).toBe(false)
    expect(loadConfig({ ...base, DRY_RUN: '0' } as NodeJS.ProcessEnv).dryRun).toBe(true)
    expect(loadConfig({ ...base, DRY_RUN: 'FALSE' } as NodeJS.ProcessEnv).dryRun).toBe(true)
  })

  it('throws when a required secret is missing', () => {
    expect(() => loadConfig({ PLEX_URL: 'x', PLEX_TOKEN: 'y' } as NodeJS.ProcessEnv)).toThrow()
  })
})
```

- [ ] **Step 5: Run it and watch it fail**

Run: `npx vitest run tests/config.test.ts`
Expected: FAIL — cannot resolve `../src/config.js`

- [ ] **Step 6: Implement `src/config.ts`**

`dryRun` is deliberately opt-out-by-exact-string so a typo can never enable writes.

```ts
import { z } from 'zod'

const Schema = z.object({
  BINGERS_SESSION_COOKIE: z.string().min(1),
  BINGERS_USER_AGENT: z.string().default('Bingers/55 CFNetwork/3896.100.1.2.1 Darwin/27.0.0'),
  PLEX_URL: z.string().min(1),
  PLEX_TOKEN: z.string().min(1),
  ALLOWED_USER: z.string().default('plexuser'),
  DRY_RUN: z.string().default('true'),
  PORT: z.coerce.number().default(8787),
  DB_PATH: z.string().default('/data/bingers-sync.db'),
  CATALOG_TTL_HOURS: z.coerce.number().default(24),
  SEARCH_MAX_PAGES: z.coerce.number().default(3),
  SYNC_PULL_INTERVAL_MIN: z.coerce.number().default(30),
  WATCH_DATE_TOLERANCE_SEC: z.coerce.number().default(120),
  PLEX_ALLLEAVES_TTL_MIN: z.coerce.number().default(60),
  NOTIFY_URL: z.string().optional(),
})

export type Config = ReturnType<typeof loadConfig>

export function loadConfig(env: NodeJS.ProcessEnv) {
  const e = Schema.parse(env)
  return {
    bingersCookie: e.BINGERS_SESSION_COOKIE,
    bingersUserAgent: e.BINGERS_USER_AGENT,
    plexUrl: e.PLEX_URL.replace(/\/+$/, ''),
    plexToken: e.PLEX_TOKEN,
    allowedUser: e.ALLOWED_USER,
    dryRun: e.DRY_RUN !== 'false',
    port: e.PORT,
    dbPath: e.DB_PATH,
    catalogTtlHours: e.CATALOG_TTL_HOURS,
    searchMaxPages: e.SEARCH_MAX_PAGES,
    syncPullIntervalMin: e.SYNC_PULL_INTERVAL_MIN,
    watchDateToleranceSec: e.WATCH_DATE_TOLERANCE_SEC,
    plexAllLeavesTtlMin: e.PLEX_ALLLEAVES_TTL_MIN,
    notifyUrl: e.NOTIFY_URL ?? null,
  }
}
```

- [ ] **Step 7: Add `.env.example`**

```
BINGERS_SESSION_COOKIE=
PLEX_URL=http://plex.local:32400
PLEX_TOKEN=
ALLOWED_USER=plexuser
DRY_RUN=true
PORT=8787
DB_PATH=/data/bingers-sync.db
CATALOG_TTL_HOURS=24
SEARCH_MAX_PAGES=3
SYNC_PULL_INTERVAL_MIN=30
WATCH_DATE_TOLERANCE_SEC=120
PLEX_ALLLEAVES_TTL_MIN=60
NOTIFY_URL=
```

- [ ] **Step 8: Add real fixtures captured from live traffic**

Create `tests/fixtures/search-tires.json` — trimmed real response from `GET /search/titles?q=tires`:

```json
{"results":[
  {"id":"019f6bb9-65cf-78d1-b123-f9ed891fe9d7","kind":"show","metadata":"543408442fd2",
   "card":{"originalTitle":"Tires","originalLanguage":"en","titlesI18n":{"de":"Tires","en":"Tires"},"posterRef":"img/351deacf7d2670305a0fd25d-orig.jpg","year":2024}},
  {"id":"019f6bed-06eb-7c02-9ac2-d2b0a9847e77","kind":"movie","metadata":"9ed3c7faa7c9",
   "card":{"originalTitle":"Gume na kotačima","originalLanguage":"hr","titlesI18n":{"en":"Tires on Wheels"},"posterRef":null,"year":2026}}
]}
```

Create `tests/fixtures/metadata-tires.json`:

```json
{"id":"019f6bb9-65cf-78d1-b123-f9ed891fe9d7","title":"Tires","year":2024,"kind":"show",
 "seasons":[{"season":0},{"season":1}],
 "external_ids":[
   {"id":"tt31491435","source":"imdb","type":"IMDB","url":null},
   {"id":"247522","source":"tmdb","type":"tv","url":null},
   {"id":"446718","source":"tvdb","type":"series","url":null}
 ]}
```

Create `tests/fixtures/versions-tires.json`:

```json
{"titleId":"019f6bb9-65cf-78d1-b123-f9ed891fe9d7","kind":"show",
 "files":{"metadata":"543408442fd2","credits":"aaaa00000001","images":"bbbb00000002",
          "seasons":{"0":"cccc00000003","1":"dddd00000004"}}}
```

Create `tests/fixtures/season1-tires.json`:

```json
{"episodes":[
 {"n":1,"abs":1,"id":"019f6bb9-65fd-7ef3-8053-8e3333a9f110","title":"Pilot","aired":"2024-05-23","air_utc":"2024-05-23T04:00:00Z","runtime":22},
 {"n":2,"abs":2,"id":"019f6bb9-65fd-7ef3-8053-8e3333a9f111","title":"Oil Change","aired":"2024-05-23","air_utc":"2024-05-23T04:00:00Z","runtime":21},
 {"n":3,"abs":3,"id":"019f6bb9-65fd-7ef3-8053-8e3333a9f117","title":"Sales Contest","aired":"2024-05-23","air_utc":"2024-05-23T04:00:00Z","runtime":23}
]}
```

- [ ] **Step 9: Run the test to verify it passes**

Run: `npx vitest run tests/config.test.ts`
Expected: PASS, 3 tests

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: project scaffold, validated config, live-traffic fixtures"
```

---

### Task 2: SQLite store

**Files:**
- Create: `src/store.ts`
- Test: `tests/store.test.ts`

**Interfaces:**
- Consumes: `Config` from Task 1
- Produces:
  - `openStore(dbPath: string): Store`
  - `Store` methods: `getTitleId(source, extId, kind): string | null`, `putTitleMapping(rows: TitleMapping[]): void`, `getEpisodeId(titleId, season, number): string | null`, `putEpisodes(rows: EpisodeMapping[]): void`, `getCatalogVersion(titleId): { files: any; fetchedAt: string } | null`, `putCatalogVersion(titleId, files): void`, `getSyncRow(table, pk): any | null`, `putSyncRows(table, rows: {pk: string; row: any}[]): void`, `getCursor(name): string | null`, `setCursor(name, value): void`, `recordFailure(source, reason, payload): void`, `listFailures(limit?): FailureRow[]`, `getAuthState(): AuthState | null`, `putAuthState(s: AuthState): void`, `close(): void`
  - `TitleMapping = { source: string; extId: string; kind: string; titleId: string; title: string | null; year: number | null }`
  - `EpisodeMapping = { titleId: string; season: number; number: number; episodeId: string; abs: number | null; title: string | null; aired: string | null; seasonHash: string }`
  - `AuthState = { cookie: string; expiresAt: string | null; rotatedAt: string | null; checkedAt: string | null }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/store.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'

let s: Store
beforeEach(() => { s = openStore(':memory:') })

describe('title_map', () => {
  it('round-trips a mapping and finds it by any of its external ids', () => {
    s.putTitleMapping([
      { source: 'tmdb', extId: '247522', kind: 'show', titleId: 'T1', title: 'Tires', year: 2024 },
      { source: 'tvdb', extId: '446718', kind: 'show', titleId: 'T1', title: 'Tires', year: 2024 },
    ])
    expect(s.getTitleId('tmdb', '247522', 'show')).toBe('T1')
    expect(s.getTitleId('tvdb', '446718', 'show')).toBe('T1')
    expect(s.getTitleId('tmdb', '247522', 'movie')).toBeNull()
    expect(s.getTitleId('imdb', 'nope', 'show')).toBeNull()
  })

  it('upserts rather than throwing on a repeated mapping', () => {
    const row = { source: 'tmdb', extId: '1', kind: 'show', titleId: 'A', title: null, year: null }
    s.putTitleMapping([row])
    s.putTitleMapping([{ ...row, titleId: 'B' }])
    expect(s.getTitleId('tmdb', '1', 'show')).toBe('B')
  })
})

describe('episode_map', () => {
  it('resolves (title, season, number) to an episode id', () => {
    s.putEpisodes([
      { titleId: 'T1', season: 1, number: 3, episodeId: 'E3', abs: 3, title: 'Sales Contest', aired: '2024-05-23', seasonHash: 'h1' },
    ])
    expect(s.getEpisodeId('T1', 1, 3)).toBe('E3')
    expect(s.getEpisodeId('T1', 1, 4)).toBeNull()
    expect(s.getEpisodeId('T1', 2, 3)).toBeNull()
  })
})

describe('sync_state', () => {
  it('stores and returns parsed rows', () => {
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', deletedAt: null } }])
    expect(s.getSyncRow('follows', 'T1')).toEqual({ titleId: 'T1', deletedAt: null })
    expect(s.getSyncRow('follows', 'T2')).toBeNull()
  })
})

describe('cursors and failures', () => {
  it('stores cursors', () => {
    expect(s.getCursor('follows')).toBeNull()
    s.setCursor('follows', '2026-09-16T10:00:00Z')
    expect(s.getCursor('follows')).toBe('2026-09-16T10:00:00Z')
  })

  it('records failures with their payload', () => {
    s.recordFailure('plex', 'no external id match', { title: 'Tires' })
    const f = s.listFailures()
    expect(f).toHaveLength(1)
    expect(f[0]!.reason).toBe('no external id match')
    expect(JSON.parse(f[0]!.payload).title).toBe('Tires')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/store.test.ts`
Expected: FAIL — cannot resolve `../src/store.js`

- [ ] **Step 3: Implement `src/store.ts`**

```ts
import Database from 'better-sqlite3'

export type TitleMapping = { source: string; extId: string; kind: string; titleId: string; title: string | null; year: number | null }
export type EpisodeMapping = { titleId: string; season: number; number: number; episodeId: string; abs: number | null; title: string | null; aired: string | null; seasonHash: string }
export type AuthState = { cookie: string; expiresAt: string | null; rotatedAt: string | null; checkedAt: string | null }
export type FailureRow = { id: number; source: string; reason: string; payload: string; created_at: string }

const SCHEMA = `
CREATE TABLE IF NOT EXISTS title_map (
  source TEXT NOT NULL, ext_id TEXT NOT NULL, kind TEXT NOT NULL,
  title_id TEXT NOT NULL, title TEXT, year INTEGER, verified_at TEXT NOT NULL,
  PRIMARY KEY (source, ext_id, kind));
CREATE INDEX IF NOT EXISTS title_map_title_id ON title_map (title_id);

CREATE TABLE IF NOT EXISTS episode_map (
  title_id TEXT NOT NULL, season INTEGER NOT NULL, number INTEGER NOT NULL,
  episode_id TEXT NOT NULL, abs INTEGER, title TEXT, aired TEXT,
  season_hash TEXT NOT NULL, fetched_at TEXT NOT NULL,
  PRIMARY KEY (title_id, season, number));
CREATE INDEX IF NOT EXISTS episode_map_episode_id ON episode_map (episode_id);

CREATE TABLE IF NOT EXISTS catalog_version (
  title_id TEXT PRIMARY KEY, files_json TEXT NOT NULL, fetched_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS sync_state (
  table_name TEXT NOT NULL, pk TEXT NOT NULL, row_json TEXT NOT NULL,
  updated_at TEXT NOT NULL, PRIMARY KEY (table_name, pk));

CREATE TABLE IF NOT EXISTS cursors (name TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS outbox (
  op_id TEXT PRIMARY KEY, batch_id TEXT, table_name TEXT NOT NULL,
  pk_json TEXT NOT NULL, fields_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_try_at TEXT,
  status TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS failures (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, reason TEXT NOT NULL,
  payload TEXT NOT NULL, created_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS auth_state (
  id INTEGER PRIMARY KEY CHECK (id = 1), cookie TEXT NOT NULL,
  expires_at TEXT, rotated_at TEXT, checked_at TEXT);
`

export function openStore(dbPath: string) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)
  const now = () => new Date().toISOString()

  return {
    getTitleId(source: string, extId: string, kind: string): string | null {
      const r = db.prepare('SELECT title_id FROM title_map WHERE source=? AND ext_id=? AND kind=?')
        .get(source, extId, kind) as { title_id: string } | undefined
      return r?.title_id ?? null
    },
    putTitleMapping(rows: TitleMapping[]) {
      const st = db.prepare(`INSERT INTO title_map (source, ext_id, kind, title_id, title, year, verified_at)
        VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(source, ext_id, kind) DO UPDATE SET
          title_id=excluded.title_id, title=excluded.title, year=excluded.year, verified_at=excluded.verified_at`)
      db.transaction(() => { for (const r of rows) st.run(r.source, r.extId, r.kind, r.titleId, r.title, r.year, now()) })()
    },
    getEpisodeId(titleId: string, season: number, number: number): string | null {
      const r = db.prepare('SELECT episode_id FROM episode_map WHERE title_id=? AND season=? AND number=?')
        .get(titleId, season, number) as { episode_id: string } | undefined
      return r?.episode_id ?? null
    },
    putEpisodes(rows: EpisodeMapping[]) {
      const st = db.prepare(`INSERT INTO episode_map (title_id, season, number, episode_id, abs, title, aired, season_hash, fetched_at)
        VALUES (?,?,?,?,?,?,?,?,?)
        ON CONFLICT(title_id, season, number) DO UPDATE SET
          episode_id=excluded.episode_id, abs=excluded.abs, title=excluded.title,
          aired=excluded.aired, season_hash=excluded.season_hash, fetched_at=excluded.fetched_at`)
      db.transaction(() => { for (const r of rows) st.run(r.titleId, r.season, r.number, r.episodeId, r.abs, r.title, r.aired, r.seasonHash, now()) })()
    },
    getCatalogVersion(titleId: string) {
      const r = db.prepare('SELECT files_json, fetched_at FROM catalog_version WHERE title_id=?')
        .get(titleId) as { files_json: string; fetched_at: string } | undefined
      return r ? { files: JSON.parse(r.files_json), fetchedAt: r.fetched_at } : null
    },
    putCatalogVersion(titleId: string, files: unknown) {
      db.prepare(`INSERT INTO catalog_version (title_id, files_json, fetched_at) VALUES (?,?,?)
        ON CONFLICT(title_id) DO UPDATE SET files_json=excluded.files_json, fetched_at=excluded.fetched_at`)
        .run(titleId, JSON.stringify(files), now())
    },
    getSyncRow(table: string, pk: string) {
      const r = db.prepare('SELECT row_json FROM sync_state WHERE table_name=? AND pk=?')
        .get(table, pk) as { row_json: string } | undefined
      return r ? JSON.parse(r.row_json) : null
    },
    putSyncRows(table: string, rows: { pk: string; row: unknown }[]) {
      const st = db.prepare(`INSERT INTO sync_state (table_name, pk, row_json, updated_at) VALUES (?,?,?,?)
        ON CONFLICT(table_name, pk) DO UPDATE SET row_json=excluded.row_json, updated_at=excluded.updated_at`)
      db.transaction(() => { for (const r of rows) st.run(table, r.pk, JSON.stringify(r.row), now()) })()
    },
    getCursor(name: string): string | null {
      const r = db.prepare('SELECT value FROM cursors WHERE name=?').get(name) as { value: string } | undefined
      return r?.value ?? null
    },
    setCursor(name: string, value: string) {
      db.prepare('INSERT INTO cursors (name, value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
        .run(name, value)
    },
    recordFailure(source: string, reason: string, payload: unknown) {
      db.prepare('INSERT INTO failures (source, reason, payload, created_at) VALUES (?,?,?,?)')
        .run(source, reason, JSON.stringify(payload), now())
    },
    listFailures(limit = 100): FailureRow[] {
      return db.prepare('SELECT * FROM failures ORDER BY id DESC LIMIT ?').all(limit) as FailureRow[]
    },
    getAuthState(): AuthState | null {
      const r = db.prepare('SELECT cookie, expires_at, rotated_at, checked_at FROM auth_state WHERE id=1').get() as any
      return r ? { cookie: r.cookie, expiresAt: r.expires_at, rotatedAt: r.rotated_at, checkedAt: r.checked_at } : null
    },
    putAuthState(s: AuthState) {
      db.prepare(`INSERT INTO auth_state (id, cookie, expires_at, rotated_at, checked_at) VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET cookie=excluded.cookie, expires_at=excluded.expires_at,
          rotated_at=excluded.rotated_at, checked_at=excluded.checked_at`)
        .run(s.cookie, s.expiresAt, s.rotatedAt, s.checkedAt)
    },
    close() { db.close() },
  }
}

export type Store = ReturnType<typeof openStore>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/store.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: sqlite store with id cache, sync mirror, failures and auth state"
```

---

### Task 3: Bingers catalog and search client

**Files:**
- Create: `src/bingers/catalog.ts`
- Test: `tests/bingers-catalog.test.ts`

**Interfaces:**
- Consumes: nothing (both hosts are public here)
- Produces:
  - `searchTitles(q: string, page?: number, fetchImpl?: typeof fetch): Promise<SearchResult[]>`
  - `SearchResult = { id: string; kind: 'show' | 'movie'; metadata: string; card: { originalTitle: string; titlesI18n: Record<string,string>; year: number | null } }`
  - `fetchVersions(titleId: string, fetchImpl?): Promise<CatalogFiles>`
  - `CatalogFiles = { metadata: string; seasons?: Record<string, string>; [k: string]: unknown }`
  - `fetchMetadata(titleId: string, hash: string, fetchImpl?): Promise<TitleMetadata>`
  - `TitleMetadata = { id: string; title: string; year: number | null; kind: string; external_ids: { id: string; source: string }[] }`
  - `fetchSeason(titleId: string, season: number, hash: string, fetchImpl?): Promise<CatalogEpisode[]>`
  - `CatalogEpisode = { n: number; abs: number | null; id: string; title: string | null; aired: string | null }`
  - `externalIdMap(m: TitleMetadata): Record<string, string>` — normalises to `{tmdb, tvdb, imdb}`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bingers-catalog.test.ts
import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { searchTitles, fetchVersions, fetchMetadata, fetchSeason, externalIdMap } from '../src/bingers/catalog.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
const stub = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }))

describe('searchTitles', () => {
  it('hits the public endpoint with no cookie and returns results', async () => {
    const f = stub(fx('search-tires'))
    const r = await searchTitles('tires', 0, f as any)
    expect(r).toHaveLength(2)
    expect(r[0]!.id).toBe('019f6bb9-65cf-78d1-b123-f9ed891fe9d7')
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toContain('https://api.bingers.app/search/titles?q=tires')
    expect(init?.headers?.Cookie).toBeUndefined()
  })
})

describe('catalog paths', () => {
  it('builds the kind@hash.json path for metadata', async () => {
    const f = stub(fx('metadata-tires'))
    await fetchMetadata('T1', 'abc123', f as any)
    expect((f as any).mock.calls[0][0])
      .toBe('https://catalog.bingers.app/catalog/T1/metadata@abc123.json')
  })

  it('builds the season-N@hash.json path for a season', async () => {
    const f = stub(fx('season1-tires'))
    const eps = await fetchSeason('T1', 1, 'dddd00000004', f as any)
    expect((f as any).mock.calls[0][0])
      .toBe('https://catalog.bingers.app/catalog/T1/season-1@dddd00000004.json')
    expect(eps).toHaveLength(3)
    expect(eps[2]).toMatchObject({ n: 3, id: '019f6bb9-65fd-7ef3-8053-8e3333a9f117' })
  })

  it('returns the files map from versions.json', async () => {
    const f = stub(fx('versions-tires'))
    const v = await fetchVersions('T1', f as any)
    expect(v.metadata).toBe('543408442fd2')
    expect(v.seasons).toEqual({ '0': 'cccc00000003', '1': 'dddd00000004' })
  })
})

describe('externalIdMap', () => {
  it('normalises the external_ids array to a lookup', () => {
    expect(externalIdMap(fx('metadata-tires'))).toEqual({
      imdb: 'tt31491435', tmdb: '247522', tvdb: '446718',
    })
  })

  it('ignores sources we do not match on', () => {
    const m = { external_ids: [{ id: 'Q1', source: 'wikidata' }, { id: '5', source: 'tmdb' }] } as any
    expect(externalIdMap(m)).toEqual({ tmdb: '5' })
  })
})

describe('error handling', () => {
  it('throws on a non-200 so the caller can retry', async () => {
    await expect(fetchVersions('T1', stub({}, 500) as any)).rejects.toThrow(/500/)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/bingers-catalog.test.ts`
Expected: FAIL — cannot resolve `../src/bingers/catalog.js`

- [ ] **Step 3: Implement `src/bingers/catalog.ts`**

```ts
const API = 'https://api.bingers.app'
const CATALOG = 'https://catalog.bingers.app'
const MATCHED_SOURCES = new Set(['tmdb', 'tvdb', 'imdb'])

export type SearchResult = {
  id: string; kind: 'show' | 'movie'; metadata: string
  card: { originalTitle: string; titlesI18n: Record<string, string>; year: number | null }
}
export type CatalogFiles = { metadata: string; seasons?: Record<string, string>; [k: string]: unknown }
export type TitleMetadata = { id: string; title: string; year: number | null; kind: string; external_ids: { id: string; source: string }[] }
export type CatalogEpisode = { n: number; abs: number | null; id: string; title: string | null; aired: string | null }

async function getJson<T>(url: string, fetchImpl: typeof fetch): Promise<T> {
  const res = await fetchImpl(url, { headers: { Accept: 'application/json' } })
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`)
  return (await res.json()) as T
}

export async function searchTitles(q: string, page = 0, fetchImpl: typeof fetch = fetch): Promise<SearchResult[]> {
  const url = `${API}/search/titles?q=${encodeURIComponent(q)}&page=${page}&lang=de`
  const body = await getJson<{ results: SearchResult[] }>(url, fetchImpl)
  return body.results ?? []
}

export function fetchVersions(titleId: string, fetchImpl: typeof fetch = fetch): Promise<CatalogFiles> {
  return getJson<{ files: CatalogFiles }>(`${CATALOG}/catalog/${titleId}/versions.json`, fetchImpl)
    .then(b => b.files)
}

export function fetchMetadata(titleId: string, hash: string, fetchImpl: typeof fetch = fetch): Promise<TitleMetadata> {
  return getJson<TitleMetadata>(`${CATALOG}/catalog/${titleId}/metadata@${hash}.json`, fetchImpl)
}

export async function fetchSeason(titleId: string, season: number, hash: string, fetchImpl: typeof fetch = fetch): Promise<CatalogEpisode[]> {
  const b = await getJson<{ episodes: CatalogEpisode[] }>(`${CATALOG}/catalog/${titleId}/season-${season}@${hash}.json`, fetchImpl)
  return b.episodes ?? []
}

export function externalIdMap(m: TitleMetadata): Record<string, string> {
  const out: Record<string, string> = {}
  for (const e of m.external_ids ?? []) {
    if (MATCHED_SOURCES.has(e.source) && !(e.source in out)) out[e.source] = String(e.id)
  }
  return out
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bingers-catalog.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: bingers public search and catalog client"
```

---

### Task 4: Title resolution — search then verify by ID

**Files:**
- Create: `src/resolve.ts`
- Test: `tests/resolve-title.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 2), `searchTitles`/`fetchMetadata`/`externalIdMap` (Task 3)
- Produces:
  - `type ExternalIds = { tmdb?: string; tvdb?: string; imdb?: string }`
  - `type ResolveDeps = { store: Store; fetchImpl?: typeof fetch; searchMaxPages: number }`
  - `resolveTitle(deps: ResolveDeps, args: { title: string; kind: 'show' | 'movie'; ids: ExternalIds }): Promise<{ titleId: string } | { failure: string }>`

- [ ] **Step 1: Write the failing test**

```ts
// tests/resolve-title.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { resolveTitle } from '../src/resolve.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
let store: Store
beforeEach(() => { store = openStore(':memory:') })

function routed(routes: Record<string, unknown>) {
  return vi.fn(async (url: string) => {
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
}

const deps = (f: any) => ({ store, fetchImpl: f as typeof fetch, searchMaxPages: 1 })

describe('resolveTitle', () => {
  it('accepts a candidate whose external ids intersect ours', async () => {
    const f = routed({ '/search/titles': fx('search-tires'), 'metadata@543408442fd2': fx('metadata-tires') })
    const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '247522' } })
    expect(r).toEqual({ titleId: '019f6bb9-65cf-78d1-b123-f9ed891fe9d7' })
  })

  it('refuses a title-and-year lookalike with no id intersection', async () => {
    const f = routed({ '/search/titles': fx('search-tires'), 'metadata@543408442fd2': fx('metadata-tires') })
    const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '999999' } })
    expect(r).toHaveProperty('failure')
  })

  it('caches every external id of a resolved title', async () => {
    const f = routed({ '/search/titles': fx('search-tires'), 'metadata@543408442fd2': fx('metadata-tires') })
    await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '247522' } })
    expect(store.getTitleId('tvdb', '446718', 'show')).toBe('019f6bb9-65cf-78d1-b123-f9ed891fe9d7')
    expect(store.getTitleId('imdb', 'tt31491435', 'show')).toBe('019f6bb9-65cf-78d1-b123-f9ed891fe9d7')
  })

  it('serves a cache hit without touching the network', async () => {
    store.putTitleMapping([{ source: 'tmdb', extId: '247522', kind: 'show', titleId: 'CACHED', title: null, year: null }])
    const f = vi.fn()
    const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '247522' } })
    expect(r).toEqual({ titleId: 'CACHED' })
    expect(f).not.toHaveBeenCalled()
  })

  it('only considers candidates of the matching kind', async () => {
    // the movie result carries tmdb 1726052; asking for a show with that id must not match
    const f = routed({ '/search/titles': fx('search-tires'), 'metadata@9ed3c7faa7c9': { external_ids: [{ id: '1726052', source: 'tmdb' }] } })
    const r = await resolveTitle(deps(f), { title: 'Tires', kind: 'show', ids: { tmdb: '1726052' } })
    expect(r).toHaveProperty('failure')
  })

  it('fails cleanly when search returns nothing', async () => {
    const f = routed({ '/search/titles': { results: [] } })
    const r = await resolveTitle(deps(f), { title: 'Nothing', kind: 'show', ids: { tmdb: '1' } })
    expect(r).toHaveProperty('failure')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/resolve-title.test.ts`
Expected: FAIL — cannot resolve `../src/resolve.js`

- [ ] **Step 3: Implement `resolveTitle` in `src/resolve.ts`**

```ts
import type { Store } from './store.js'
import { searchTitles, fetchMetadata, externalIdMap, type TitleMetadata } from './bingers/catalog.js'

export type ExternalIds = { tmdb?: string; tvdb?: string; imdb?: string }
export type ResolveDeps = { store: Store; fetchImpl?: typeof fetch; searchMaxPages: number }

const SOURCES = ['tmdb', 'tvdb', 'imdb'] as const

function intersects(a: ExternalIds, b: Record<string, string>): boolean {
  return SOURCES.some(s => a[s] != null && b[s] != null && String(a[s]) === b[s])
}

function cacheAll(store: Store, meta: TitleMetadata, kind: string, titleId: string) {
  const ids = externalIdMap(meta)
  store.putTitleMapping(
    Object.entries(ids).map(([source, extId]) => ({
      source, extId, kind, titleId, title: meta.title ?? null, year: meta.year ?? null,
    })),
  )
}

export async function resolveTitle(
  deps: ResolveDeps,
  args: { title: string; kind: 'show' | 'movie'; ids: ExternalIds },
): Promise<{ titleId: string } | { failure: string }> {
  const { store, searchMaxPages } = deps
  const fetchImpl = deps.fetchImpl ?? fetch

  for (const s of SOURCES) {
    const v = args.ids[s]
    if (!v) continue
    const hit = store.getTitleId(s, String(v), args.kind)
    if (hit) return { titleId: hit }
  }

  if (!SOURCES.some(s => args.ids[s])) return { failure: 'no external ids supplied' }

  for (let page = 0; page < searchMaxPages; page++) {
    let results
    try {
      results = await searchTitles(args.title, page, fetchImpl)
    } catch (e) {
      return { failure: `search failed: ${(e as Error).message}` }
    }
    if (results.length === 0) break

    for (const r of results) {
      if (r.kind !== args.kind) continue
      let meta: TitleMetadata
      try {
        meta = await fetchMetadata(r.id, r.metadata, fetchImpl)
      } catch { continue }
      if (intersects(args.ids, externalIdMap(meta))) {
        cacheAll(store, meta, args.kind, r.id)
        return { titleId: r.id }
      }
    }
  }
  return { failure: `no external id match for ${args.kind} ${JSON.stringify(args.ids)}` }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/resolve-title.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: resolve titles by verified external id intersection"
```

---

### Task 5: Episode resolution and the full-season cache

**Files:**
- Modify: `src/resolve.ts` (append)
- Test: `tests/resolve-episode.test.ts`

**Interfaces:**
- Consumes: `fetchVersions`/`fetchSeason` (Task 3), `Store` (Task 2)
- Produces:
  - `resolveEpisode(deps: ResolveDeps & { catalogTtlHours: number }, args: { titleId: string; season: number; number: number }): Promise<{ episodeId: string } | { failure: string }>`
  - `hydrateEpisodes(deps, titleId: string): Promise<void>` — fetches versions.json plus every season, upserting `episode_map`

- [ ] **Step 1: Write the failing test**

```ts
// tests/resolve-episode.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { resolveEpisode } from '../src/resolve.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
let store: Store
beforeEach(() => { store = openStore(':memory:') })

function routed(routes: Record<string, unknown>, counter?: { n: number }) {
  return vi.fn(async (url: string) => {
    if (counter) counter.n++
    for (const [frag, body] of Object.entries(routes)) {
      if (url.includes(frag)) return new Response(JSON.stringify(body), { status: 200 })
    }
    return new Response('{}', { status: 404 })
  })
}

const ROUTES = {
  'versions.json': fx('versions-tires'),
  'season-1@dddd00000004.json': fx('season1-tires'),
  'season-0@cccc00000003.json': { episodes: [{ n: 1, abs: 0, id: 'SPECIAL1', title: 'Behind the scenes', aired: '2024-05-01' }] },
}
const deps = (f: any) => ({ store, fetchImpl: f as typeof fetch, searchMaxPages: 1, catalogTtlHours: 24 })

describe('resolveEpisode', () => {
  it('resolves a season/number pair to the bingers episode id', async () => {
    const r = await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 1, number: 3 })
    expect(r).toEqual({ episodeId: '019f6bb9-65fd-7ef3-8053-8e3333a9f117' })
  })

  it('hydrates every season on first resolution, including season 0', async () => {
    await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 1, number: 3 })
    expect(store.getEpisodeId('T1', 1, 1)).toBe('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
    expect(store.getEpisodeId('T1', 0, 1)).toBe('SPECIAL1')
  })

  it('makes no network calls at all on a second episode of the same show', async () => {
    const c = { n: 0 }
    const f = routed(ROUTES, c)
    await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 3 })
    const afterFirst = c.n
    expect(afterFirst).toBeGreaterThan(0)
    await resolveEpisode(deps(f), { titleId: 'T1', season: 1, number: 1 })
    expect(c.n).toBe(afterFirst)
  })

  it('fails cleanly for an episode the catalog does not have', async () => {
    const r = await resolveEpisode(deps(routed(ROUTES)), { titleId: 'T1', season: 9, number: 9 })
    expect(r).toHaveProperty('failure')
  })

  it('re-hydrates when an episode is missing, picking up a newly aired one', async () => {
    const f1 = routed(ROUTES)
    await resolveEpisode(deps(f1), { titleId: 'T1', season: 1, number: 3 })

    const grown = { episodes: [...fx('season1-tires').episodes, { n: 4, abs: 4, id: 'NEW4', title: 'New', aired: '2026-01-01' }] }
    const f2 = routed({
      'versions.json': { titleId: 'T1', kind: 'show', files: { metadata: 'm', seasons: { '0': 'cccc00000003', '1': 'HASHCHANGED' } } },
      'season-1@HASHCHANGED.json': grown,
      'season-0@cccc00000003.json': ROUTES['season-0@cccc00000003.json'],
    })
    const r = await resolveEpisode(deps(f2), { titleId: 'T1', season: 1, number: 4 })
    expect(r).toEqual({ episodeId: 'NEW4' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/resolve-episode.test.ts`
Expected: FAIL — `resolveEpisode` is not exported

- [ ] **Step 3: Append to `src/resolve.ts`**

Merge these two imports into the existing import block at the top of the file, then append the rest.

```ts
// merge with the existing imports at the top of resolve.ts
import { fetchVersions, fetchSeason } from './bingers/catalog.js'
import type { EpisodeMapping } from './store.js'

export type EpisodeDeps = ResolveDeps & { catalogTtlHours: number }

export async function hydrateEpisodes(deps: EpisodeDeps, titleId: string): Promise<void> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const files = await fetchVersions(titleId, fetchImpl)
  deps.store.putCatalogVersion(titleId, files)
  const seasons = files.seasons ?? {}
  for (const [seasonStr, hash] of Object.entries(seasons)) {
    const season = Number(seasonStr)
    let eps
    try {
      eps = await fetchSeason(titleId, season, hash, fetchImpl)
    } catch { continue }
    const rows: EpisodeMapping[] = eps.map(e => ({
      titleId, season, number: e.n, episodeId: e.id,
      abs: e.abs ?? null, title: e.title ?? null, aired: e.aired ?? null, seasonHash: hash,
    }))
    if (rows.length) deps.store.putEpisodes(rows)
  }
}

export async function resolveEpisode(
  deps: EpisodeDeps,
  args: { titleId: string; season: number; number: number },
): Promise<{ episodeId: string } | { failure: string }> {
  const hit = deps.store.getEpisodeId(args.titleId, args.season, args.number)
  if (hit) return { episodeId: hit }

  try {
    await hydrateEpisodes(deps, args.titleId)
  } catch (e) {
    return { failure: `catalog hydrate failed: ${(e as Error).message}` }
  }

  const after = deps.store.getEpisodeId(args.titleId, args.season, args.number)
  if (after) return { episodeId: after }
  return { failure: `no episode S${args.season}E${args.number} for title ${args.titleId}` }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/resolve-episode.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: episode resolution with whole-show season cache"
```

---

### Task 6: Plex client

**Files:**
- Create: `src/plex/client.ts`
- Test: `tests/plex-client.test.ts`

**Interfaces:**
- Consumes: `Config` (Task 1)
- Produces:
  - `type PlexDeps = { plexUrl: string; plexToken: string; fetchImpl?: typeof fetch }`
  - `fetchShowIds(deps: PlexDeps, ratingKey: string): Promise<ExternalIds>`
  - `fetchAllLeaves(deps: PlexDeps, ratingKey: string): Promise<PlexEpisode[]>`
  - `PlexEpisode = { season: number; number: number; viewCount: number; lastViewedAt: number | null; title: string | null }`
  - `parseGuids(guids: { id: string }[]): ExternalIds`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plex-client.test.ts
import { describe, it, expect, vi } from 'vitest'
import { fetchShowIds, fetchAllLeaves, parseGuids } from '../src/plex/client.js'

const deps = (f: any) => ({ plexUrl: 'http://plex.local:32400', plexToken: 'tok', fetchImpl: f as typeof fetch })
const stub = (body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))

describe('parseGuids', () => {
  it('parses the scheme://id form into a lookup', () => {
    expect(parseGuids([{ id: 'imdb://tt31491435' }, { id: 'tmdb://247522' }, { id: 'tvdb://446718' }]))
      .toEqual({ imdb: 'tt31491435', tmdb: '247522', tvdb: '446718' })
  })
  it('ignores schemes we do not match on', () => {
    expect(parseGuids([{ id: 'plex://show/abc' }, { id: 'tmdb://5' }])).toEqual({ tmdb: '5' })
  })
})

describe('fetchShowIds', () => {
  it('requests the show ratingKey with includeGuids and the token header', async () => {
    const f = stub({ MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://247522' }, { id: 'tvdb://446718' }] }] } })
    const ids = await fetchShowIds(deps(f), '90363')
    expect(ids).toEqual({ tmdb: '247522', tvdb: '446718' })
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('http://plex.local:32400/library/metadata/90363?includeGuids=1')
    expect(init.headers['X-Plex-Token']).toBe('tok')
  })

  it('returns an empty map when Plex knows no external ids', async () => {
    const f = stub({ MediaContainer: { Metadata: [{}] } })
    expect(await fetchShowIds(deps(f), '1')).toEqual({})
  })
})

describe('fetchAllLeaves', () => {
  it('maps episodes to season/number/viewCount/lastViewedAt', async () => {
    const f = stub({ MediaContainer: { Metadata: [
      { parentIndex: 1, index: 1, viewCount: 1, lastViewedAt: 1789000000, title: 'Pilot' },
      { parentIndex: 1, index: 2, title: 'Unwatched' },
      { parentIndex: 1, index: 3, viewCount: 2, lastViewedAt: 1789553428, title: 'Sales Contest' },
    ] } })
    const eps = await fetchAllLeaves(deps(f), '90363')
    expect((f as any).mock.calls[0][0]).toBe('http://plex.local:32400/library/metadata/90363/allLeaves')
    expect(eps).toHaveLength(3)
    expect(eps[1]).toEqual({ season: 1, number: 2, viewCount: 0, lastViewedAt: null, title: 'Unwatched' })
    expect(eps[2]).toEqual({ season: 1, number: 3, viewCount: 2, lastViewedAt: 1789553428, title: 'Sales Contest' })
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/plex-client.test.ts`
Expected: FAIL — cannot resolve `../src/plex/client.js`

- [ ] **Step 3: Implement `src/plex/client.ts`**

```ts
import type { ExternalIds } from '../resolve.js'

export type PlexDeps = { plexUrl: string; plexToken: string; fetchImpl?: typeof fetch }
export type PlexEpisode = { season: number; number: number; viewCount: number; lastViewedAt: number | null; title: string | null }

const SCHEMES = new Set(['tmdb', 'tvdb', 'imdb'])

export function parseGuids(guids: { id: string }[] | undefined): ExternalIds {
  const out: ExternalIds = {}
  for (const g of guids ?? []) {
    const m = /^([a-z]+):\/\/(.+)$/.exec(g.id ?? '')
    if (!m) continue
    const [, scheme, id] = m
    if (scheme && id && SCHEMES.has(scheme) && !(scheme in out)) (out as any)[scheme] = id
  }
  return out
}

async function plexGet<T>(deps: PlexDeps, path: string): Promise<T> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const res = await fetchImpl(`${deps.plexUrl}${path}`, {
    headers: { 'X-Plex-Token': deps.plexToken, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`plex GET ${path} -> ${res.status}`)
  return (await res.json()) as T
}

export async function fetchShowIds(deps: PlexDeps, ratingKey: string): Promise<ExternalIds> {
  const b = await plexGet<{ MediaContainer?: { Metadata?: { Guid?: { id: string }[] }[] } }>(
    deps, `/library/metadata/${ratingKey}?includeGuids=1`)
  return parseGuids(b.MediaContainer?.Metadata?.[0]?.Guid)
}

export async function fetchAllLeaves(deps: PlexDeps, ratingKey: string): Promise<PlexEpisode[]> {
  const b = await plexGet<{ MediaContainer?: { Metadata?: any[] } }>(deps, `/library/metadata/${ratingKey}/allLeaves`)
  return (b.MediaContainer?.Metadata ?? []).map(m => ({
    season: Number(m.parentIndex),
    number: Number(m.index),
    viewCount: Number(m.viewCount ?? 0),
    lastViewedAt: m.lastViewedAt != null ? Number(m.lastViewedAt) : null,
    title: m.title ?? null,
  }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/plex-client.test.ts`
Expected: PASS, 5 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: plex client for show guids and episode watch state"
```

---

### Task 7: The op planner (pure, no I/O)

**Files:**
- Create: `src/plan.ts`
- Test: `tests/plan.test.ts`

**Interfaces:**
- Consumes: nothing at runtime — a pure function
- Produces:
  - `type Op = { opId: string; table: 'follows'; pk: { titleId: string }; fields: { kind: string; forLater: boolean; stopped: boolean; watchlistHidden: boolean } } | { opId: string; table: 'follows'; pk: { titleId: string }; deleted: true } | { opId: string; table: 'entries'; pk: { entityKind: 'episode' | 'movie'; entityId: string }; fields: { watched: true; plays: number; batchId: string | null } }`
  - `type DatedWrite = { entityKind: 'episode' | 'movie'; entityId: string; watchedAt: string }`
  - `type Plan = { ops: Op[]; dated: DatedWrite[] }`
  - `planScrobble(input: ScrobbleInput): Plan`
  - `planWatchlist(input: { titleId: string; kind: string; action: 'added' | 'removed'; newId: () => string }): Plan`
  - `ScrobbleInput = { titleId: string; kind: 'show' | 'movie'; entityKind: 'episode' | 'movie'; entityId: string; plays: number; watchedAt: string; isFollowed: boolean; backfill: { episodeId: string; plays: number; watchedAt: string }[]; newId: () => string }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/plan.test.ts
import { describe, it, expect } from 'vitest'
import { planScrobble, planWatchlist } from '../src/plan.js'

let counter = 0
const newId = () => `id-${++counter}`
const base = {
  titleId: 'T1', kind: 'show' as const, entityKind: 'episode' as const, entityId: 'E3',
  plays: 1, watchedAt: '2026-09-16T10:00:00.000Z', isFollowed: true, backfill: [], newId,
}

describe('planScrobble', () => {
  it('emits a single entries op for a followed show', () => {
    counter = 0
    const p = planScrobble(base)
    expect(p.ops).toHaveLength(1)
    expect(p.ops[0]).toMatchObject({
      table: 'entries', pk: { entityKind: 'episode', entityId: 'E3' },
      fields: { watched: true, plays: 1, batchId: null },
    })
  })

  it('emits the follow op BEFORE the entry when the show is not followed', () => {
    counter = 0
    const p = planScrobble({ ...base, isFollowed: false })
    expect(p.ops).toHaveLength(2)
    expect(p.ops[0]).toMatchObject({
      table: 'follows', pk: { titleId: 'T1' },
      fields: { kind: 'show', forLater: false, stopped: false, watchlistHidden: false },
    })
    expect(p.ops[1]!.table).toBe('entries')
  })

  it('never sends timestamps in push fields', () => {
    counter = 0
    const p = planScrobble({ ...base, isFollowed: false })
    for (const op of p.ops) {
      const f = JSON.stringify('fields' in op ? op.fields : {})
      expect(f).not.toContain('WatchedAt')
      expect(f).not.toContain('followedAt')
    }
  })

  it('tags every backfilled entry with one shared batchId and keeps per-episode plays', () => {
    counter = 0
    const p = planScrobble({
      ...base,
      backfill: [
        { episodeId: 'E1', plays: 1, watchedAt: '2026-09-02T20:00:00.000Z' },
        { episodeId: 'E2', plays: 3, watchedAt: '2026-09-03T20:00:00.000Z' },
      ],
    })
    const entries = p.ops.filter(o => o.table === 'entries') as any[]
    expect(entries).toHaveLength(3)
    const batchIds = new Set(entries.map(e => e.fields.batchId))
    expect(batchIds.size).toBe(1)
    expect([...batchIds][0]).not.toBeNull()
    expect(entries.find(e => e.pk.entityId === 'E2').fields.plays).toBe(3)
  })

  it('leaves batchId null when there is nothing to backfill', () => {
    counter = 0
    const p = planScrobble(base)
    expect((p.ops[0] as any).fields.batchId).toBeNull()
  })

  it('returns a dated write per entry, carrying each episode real watch time', () => {
    counter = 0
    const p = planScrobble({
      ...base,
      backfill: [{ episodeId: 'E1', plays: 1, watchedAt: '2026-09-02T20:00:00.000Z' }],
    })
    expect(p.dated).toEqual([
      { entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-16T10:00:00.000Z' },
      { entityKind: 'episode', entityId: 'E1', watchedAt: '2026-09-02T20:00:00.000Z' },
    ])
  })

  it('handles a movie as entityKind movie with the titleId as entityId', () => {
    counter = 0
    const p = planScrobble({ ...base, kind: 'movie', entityKind: 'movie', entityId: 'T1', isFollowed: false })
    const entry = p.ops.find(o => o.table === 'entries') as any
    expect(entry.pk).toEqual({ entityKind: 'movie', entityId: 'T1' })
    const follow = p.ops.find(o => o.table === 'follows') as any
    expect(follow.fields.kind).toBe('movie')
  })
})

describe('planWatchlist', () => {
  it('emits a follows update on added', () => {
    counter = 0
    const p = planWatchlist({ titleId: 'T1', kind: 'show', action: 'added', newId })
    expect(p.ops[0]).toMatchObject({
      table: 'follows', pk: { titleId: 'T1' },
      fields: { kind: 'show', forLater: false, stopped: false, watchlistHidden: false },
    })
  })

  it('emits op-level deleted:true on removed, with no fields key', () => {
    counter = 0
    const p = planWatchlist({ titleId: 'T1', kind: 'show', action: 'removed', newId })
    const op = p.ops[0] as any
    expect(op.deleted).toBe(true)
    expect(op.fields).toBeUndefined()
    expect(Object.keys(op).sort()).toEqual(['deleted', 'opId', 'pk', 'table'])
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/plan.test.ts`
Expected: FAIL — cannot resolve `../src/plan.js`

- [ ] **Step 3: Implement `src/plan.ts`**

```ts
export type FollowFields = { kind: string; forLater: boolean; stopped: boolean; watchlistHidden: boolean }
export type Op =
  | { opId: string; table: 'follows'; pk: { titleId: string }; fields: FollowFields }
  | { opId: string; table: 'follows'; pk: { titleId: string }; deleted: true }
  | { opId: string; table: 'entries'; pk: { entityKind: 'episode' | 'movie'; entityId: string }; fields: { watched: true; plays: number; batchId: string | null } }

export type DatedWrite = { entityKind: 'episode' | 'movie'; entityId: string; watchedAt: string }
export type Plan = { ops: Op[]; dated: DatedWrite[] }

export type ScrobbleInput = {
  titleId: string
  kind: 'show' | 'movie'
  entityKind: 'episode' | 'movie'
  entityId: string
  plays: number
  watchedAt: string
  isFollowed: boolean
  backfill: { episodeId: string; plays: number; watchedAt: string }[]
  newId: () => string
}

function followOp(newId: () => string, titleId: string, kind: string): Op {
  return { opId: newId(), table: 'follows', pk: { titleId }, fields: { kind, forLater: false, stopped: false, watchlistHidden: false } }
}

export function planScrobble(input: ScrobbleInput): Plan {
  const ops: Op[] = []
  const dated: DatedWrite[] = []

  if (!input.isFollowed) ops.push(followOp(input.newId, input.titleId, input.kind))

  const batchId = input.backfill.length > 0 ? input.newId() : null

  ops.push({
    opId: input.newId(), table: 'entries',
    pk: { entityKind: input.entityKind, entityId: input.entityId },
    fields: { watched: true, plays: input.plays, batchId },
  })
  dated.push({ entityKind: input.entityKind, entityId: input.entityId, watchedAt: input.watchedAt })

  for (const b of input.backfill) {
    ops.push({
      opId: input.newId(), table: 'entries',
      pk: { entityKind: 'episode', entityId: b.episodeId },
      fields: { watched: true, plays: b.plays, batchId },
    })
    dated.push({ entityKind: 'episode', entityId: b.episodeId, watchedAt: b.watchedAt })
  }

  return { ops, dated }
}

export function planWatchlist(input: { titleId: string; kind: string; action: 'added' | 'removed'; newId: () => string }): Plan {
  if (input.action === 'removed') {
    return { ops: [{ opId: input.newId(), table: 'follows', pk: { titleId: input.titleId }, deleted: true }], dated: [] }
  }
  return { ops: [followOp(input.newId, input.titleId, input.kind)], dated: [] }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/plan.test.ts`
Expected: PASS, 9 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: pure op planner for scrobbles and watchlist changes"
```

---

### Task 8: Bingers auth — cookie jar, heartbeat, expiry tracking

**Files:**
- Create: `src/bingers/auth.ts`
- Test: `tests/bingers-auth.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 2)
- Produces:
  - `type Auth = { cookieHeader(): string; absorb(res: Response): void; heartbeat(fetchImpl?): Promise<{ expiresAt: string | null; rotated: boolean }>; daysRemaining(): number | null }`
  - `createAuth(store: Store, initialCookie: string, userAgent: string): Auth`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bingers-auth.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const SESSION = { session: { expiresAt: '2027-09-16T08:20:14.792Z' }, user: { id: 'u1' } }

describe('createAuth', () => {
  it('builds the cookie header from the configured token', () => {
    const a = createAuth(store, 'TOK', 'UA')
    expect(a.cookieHeader()).toBe('__Secure-better-auth.session_token=TOK')
  })

  it('prefers a persisted rotated cookie over the configured one', () => {
    store.putAuthState({ cookie: 'ROTATED', expiresAt: null, rotatedAt: null, checkedAt: null })
    expect(createAuth(store, 'TOK', 'UA').cookieHeader()).toBe('__Secure-better-auth.session_token=ROTATED')
  })

  it('absorbs a rotated session_token from Set-Cookie and persists it', () => {
    const a = createAuth(store, 'TOK', 'UA')
    const res = new Response('{}', { headers: {
      'set-cookie': '__Secure-better-auth.session_token=NEWTOK; Max-Age=31536000; Path=/; Secure' } })
    a.absorb(res)
    expect(a.cookieHeader()).toBe('__Secure-better-auth.session_token=NEWTOK')
    expect(store.getAuthState()!.cookie).toBe('NEWTOK')
    expect(store.getAuthState()!.rotatedAt).not.toBeNull()
  })

  it('ignores the 5-minute session_data cache cookie', () => {
    const a = createAuth(store, 'TOK', 'UA')
    a.absorb(new Response('{}', { headers: { 'set-cookie': '__Secure-better-auth.session_data=abc; Max-Age=300' } }))
    expect(a.cookieHeader()).toBe('__Secure-better-auth.session_token=TOK')
  })

  it('records expiresAt from the heartbeat', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 }))
    const a = createAuth(store, 'TOK', 'UA')
    const r = await a.heartbeat(f as any)
    expect(r.expiresAt).toBe('2027-09-16T08:20:14.792Z')
    expect(store.getAuthState()!.expiresAt).toBe('2027-09-16T08:20:14.792Z')
    expect((f as any).mock.calls[0][0]).toContain('/auth/get-session?disableCookieCache=true')
  })

  it('reports a sliding session when expiresAt moves forward', async () => {
    const a = createAuth(store, 'TOK', 'UA')
    await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(SESSION), { status: 200 })) as any)
    const later = { session: { expiresAt: '2027-09-17T08:20:14.792Z' } }
    const r = await a.heartbeat(vi.fn(async () => new Response(JSON.stringify(later), { status: 200 })) as any)
    expect(r.expiresAt).toBe('2027-09-17T08:20:14.792Z')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/bingers-auth.test.ts`
Expected: FAIL — cannot resolve `../src/bingers/auth.js`

- [ ] **Step 3: Implement `src/bingers/auth.ts`**

```ts
import type { Store } from '../store.js'

const COOKIE_NAME = '__Secure-better-auth.session_token'
const API = 'https://api.bingers.app'

export function createAuth(store: Store, initialCookie: string, userAgent: string) {
  let cookie = store.getAuthState()?.cookie ?? initialCookie

  function persist(patch: Partial<{ expiresAt: string | null; rotatedAt: string | null; checkedAt: string | null }>) {
    const prev = store.getAuthState()
    store.putAuthState({
      cookie,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : prev?.expiresAt ?? null,
      rotatedAt: patch.rotatedAt !== undefined ? patch.rotatedAt : prev?.rotatedAt ?? null,
      checkedAt: patch.checkedAt !== undefined ? patch.checkedAt : prev?.checkedAt ?? null,
    })
  }

  return {
    cookieHeader() { return `${COOKIE_NAME}=${cookie}` },

    absorb(res: Response) {
      const raw = (res.headers as any).getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean)
      for (const line of raw as string[]) {
        const m = new RegExp(`${COOKIE_NAME.replace(/\./g, '\\.')}=([^;]+)`).exec(line)
        if (m?.[1] && m[1] !== cookie) {
          cookie = m[1]
          persist({ rotatedAt: new Date().toISOString() })
        }
      }
    },

    async heartbeat(fetchImpl: typeof fetch = fetch) {
      const before = store.getAuthState()?.cookie
      const res = await fetchImpl(`${API}/auth/get-session?disableCookieCache=true`, {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}`, 'User-Agent': userAgent, Accept: 'application/json' },
      })
      this.absorb(res)
      if (!res.ok) throw new Error(`heartbeat -> ${res.status}`)
      const body = (await res.json()) as { session?: { expiresAt?: string } } | null
      const expiresAt = body?.session?.expiresAt ?? null
      persist({ expiresAt, checkedAt: new Date().toISOString() })
      return { expiresAt, rotated: store.getAuthState()?.cookie !== before }
    },

    daysRemaining(): number | null {
      const e = store.getAuthState()?.expiresAt
      if (!e) return null
      return Math.floor((Date.parse(e) - Date.now()) / 86_400_000)
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bingers-auth.test.ts`
Expected: PASS, 6 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: bingers auth with cookie rotation and expiry heartbeat"
```

---

### Task 9: Bingers sync client — push, pull, dated writes

**Files:**
- Create: `src/bingers/sync.ts`
- Test: `tests/bingers-sync.test.ts`

**Interfaces:**
- Consumes: `Op`/`DatedWrite` (Task 7), `Auth` (Task 8), `Store` (Task 2)
- Produces:
  - `type SyncDeps = { auth: Auth; store: Store; userAgent: string; dryRun: boolean; watchDateToleranceSec: number; fetchImpl?: typeof fetch }`
  - `pushOps(deps: SyncDeps, ops: Op[]): Promise<{ applied: number; rows: any } | { dryRun: true }>`
  - `applyDates(deps: SyncDeps, dated: DatedWrite[]): Promise<number>` — returns the number of PATCHes actually sent
  - `pullOnce(deps: SyncDeps): Promise<void>` — updates `sync_state` and `cursors`

- [ ] **Step 1: Write the failing test**

```ts
// tests/bingers-sync.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { pushOps, applyDates, pullOnce } from '../src/bingers/sync.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const mk = (dryRun: boolean, f: any, tol = 120) => ({
  auth: createAuth(store, 'TOK', 'UA'), store, userAgent: 'UA', dryRun,
  watchDateToleranceSec: tol, fetchImpl: f as typeof fetch,
})

const OP = { opId: 'o1', table: 'entries' as const, pk: { entityKind: 'episode' as const, entityId: 'E3' }, fields: { watched: true as const, plays: 1, batchId: null } }

describe('pushOps', () => {
  it('sends nothing at all in dry run', async () => {
    const f = vi.fn()
    expect(await pushOps(mk(true, f), [OP])).toEqual({ dryRun: true })
    expect(f).not.toHaveBeenCalled()
  })

  it('posts one batch with a clientBatchId and the session cookie', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ results: [{ opId: 'o1', status: 'applied' }], rows: {} }), { status: 200 }))
    await pushOps(mk(false, f), [OP])
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('https://api.bingers.app/sync/push')
    expect(init.method).toBe('POST')
    expect(init.headers.Cookie).toBe('__Secure-better-auth.session_token=TOK')
    const body = JSON.parse(init.body)
    expect(body.clientBatchId).toMatch(/^[0-9a-f-]{36}$/)
    expect(body.ops).toHaveLength(1)
  })

  it('throws on 401 so the caller can halt writing', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 401 }))
    await expect(pushOps(mk(false, f), [OP])).rejects.toThrow(/401/)
  })
})

describe('applyDates', () => {
  it('skips the patch when the server stamp is already within tolerance', async () => {
    const serverTime = new Date().toISOString()
    const f = vi.fn(async (url: string) => {
      if (url.includes('/me/watches?')) return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: serverTime }] }), { status: 200 })
      return new Response('{}', { status: 200 })
    })
    const n = await applyDates(mk(false, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: serverTime }])
    expect(n).toBe(0)
    expect((f as any).mock.calls.every((c: any[]) => !String(c[1]?.method).includes('PATCH'))).toBe(true)
  })

  it('patches the watch record when the real date differs', async () => {
    const f = vi.fn(async (url: string) => {
      if (url.includes('/me/watches?')) return new Response(JSON.stringify({ watches: [{ id: 'w1', watchedAt: '2026-09-16T10:50:17.841Z' }] }), { status: 200 })
      return new Response(JSON.stringify({ entry: {} }), { status: 200 })
    })
    const n = await applyDates(mk(false, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-11T10:40:47.414Z' }])
    expect(n).toBe(1)
    const patch = (f as any).mock.calls.find((c: any[]) => c[1]?.method === 'PATCH')
    expect(patch[0]).toBe('https://api.bingers.app/me/watches/w1')
    expect(JSON.parse(patch[1].body)).toEqual({
      watchedAt: '2026-09-11T10:40:47.414Z', entityKind: 'episode', entityId: 'E3',
    })
  })

  it('does nothing in dry run', async () => {
    const f = vi.fn()
    expect(await applyDates(mk(true, f), [{ entityKind: 'episode', entityId: 'E3', watchedAt: '2026-01-01T00:00:00.000Z' }])).toBe(0)
    expect(f).not.toHaveBeenCalled()
  })
})

describe('pullOnce', () => {
  it('stores follows and entries rows and advances the cursors', async () => {
    const body = {
      follows: [{ titleId: 'T1', kind: 'show', deletedAt: null }],
      entries: [{ entityKind: 'episode', entityId: 'E3', watched: true }],
      cursors: { follows: '2026-09-16T10:00:00.000Z', entries: '2026-09-16T10:00:00.000000Z~episode~E3' },
    }
    const f = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }))
    await pullOnce(mk(false, f))
    expect(store.getSyncRow('follows', 'T1')).toMatchObject({ titleId: 'T1' })
    expect(store.getSyncRow('entries', 'episode:E3')).toMatchObject({ entityId: 'E3' })
    expect(store.getCursor('follows')).toBe('2026-09-16T10:00:00.000Z')
  })

  it('sends stored cursors on the next pull', async () => {
    store.setCursor('follows', 'CURSOR1')
    const f = vi.fn(async () => new Response(JSON.stringify({ cursors: {} }), { status: 200 }))
    await pullOnce(mk(false, f))
    expect((f as any).mock.calls[0][0]).toContain('follows=CURSOR1')
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/bingers-sync.test.ts`
Expected: FAIL — cannot resolve `../src/bingers/sync.js`

- [ ] **Step 3: Implement `src/bingers/sync.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/bingers-sync.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: bingers sync client with push, dated writes and cursored pull"
```

---

### Task 10: Webhook payload parsing and user filtering

**Files:**
- Create: `src/routes/parse.ts`
- Test: `tests/parse.test.ts`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `parsePlexScrobble(form: FormData): PlexScrobble | null`
  - `PlexScrobble = { user: string; type: 'episode' | 'movie'; showRatingKey: string | null; guids: { id: string }[]; grandparentTitle: string | null; title: string; year: number | null; season: number | null; number: number | null; viewCount: number; lastViewedAt: number | null }`
  - `parsePulsarr(body: unknown): PulsarrEvent | null`
  - `PulsarrEvent = { user: string; action: 'added' | 'removed'; title: string; kind: 'show' | 'movie'; guids: { id: string }[] }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/parse.test.ts
import { describe, it, expect } from 'vitest'
import { parsePlexScrobble, parsePulsarr } from '../src/routes/parse.js'

const PLEX = {
  event: 'media.scrobble', user: true, owner: true,
  Account: { id: 5194, title: 'plexuser' },
  Metadata: {
    type: 'episode', ratingKey: '90366', grandparentRatingKey: '90363',
    title: 'Sales Contest', grandparentTitle: 'Tires', parentIndex: 1, index: 3,
    year: 2024, viewCount: 2, lastViewedAt: 1789553428,
    Guid: [{ id: 'imdb://tt32227357' }, { id: 'tmdb://5175711' }, { id: 'tvdb://10339872' }],
  },
}

const PULSARR = {
  event: 'watchlist.added', timestamp: '2026-09-16T10:14:45.738Z',
  data: {
    addedBy: { userId: 1, username: 'plexuser' },
    content: { title: 'The Mentalist', type: 'show', key: '5d9c08353c3f87001f34a531',
               guids: ['imdb:tt1196946', 'tmdb:5920', 'tvdb:82459'] },
  },
}

function form(payload: unknown) {
  const f = new FormData()
  f.set('payload', JSON.stringify(payload))
  return f
}

describe('parsePlexScrobble', () => {
  it('extracts the fields we act on from the multipart payload part', () => {
    const p = parsePlexScrobble(form(PLEX))!
    expect(p.user).toBe('plexuser')
    expect(p.type).toBe('episode')
    expect(p.showRatingKey).toBe('90363')
    expect(p.grandparentTitle).toBe('Tires')
    expect(p.season).toBe(1)
    expect(p.number).toBe(3)
    expect(p.viewCount).toBe(2)
    expect(p.lastViewedAt).toBe(1789553428)
  })

  it('ignores any event that is not media.scrobble', () => {
    expect(parsePlexScrobble(form({ ...PLEX, event: 'media.play' }))).toBeNull()
  })

  it('returns null when the payload part is absent', () => {
    expect(parsePlexScrobble(new FormData())).toBeNull()
  })

  it('reads movie scrobbles with no season or episode number', () => {
    const p = parsePlexScrobble(form({
      ...PLEX, Metadata: { ...PLEX.Metadata, type: 'movie', grandparentRatingKey: undefined, parentIndex: undefined, index: undefined },
    }))!
    expect(p.type).toBe('movie')
    expect(p.season).toBeNull()
    expect(p.showRatingKey).toBeNull()
  })
})

describe('parsePulsarr', () => {
  it('parses added, normalising colon-form guids to scheme://id', () => {
    const p = parsePulsarr(PULSARR)!
    expect(p.user).toBe('plexuser')
    expect(p.action).toBe('added')
    expect(p.kind).toBe('show')
    expect(p.guids).toEqual([{ id: 'imdb://tt1196946' }, { id: 'tmdb://5920' }, { id: 'tvdb://82459' }])
  })

  it('parses removed', () => {
    expect(parsePulsarr({ ...PULSARR, event: 'watchlist.removed' })!.action).toBe('removed')
  })

  it('ignores unrelated events', () => {
    expect(parsePulsarr({ ...PULSARR, event: 'watchlist.synced' })).toBeNull()
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/parse.test.ts`
Expected: FAIL — cannot resolve `../src/routes/parse.js`

- [ ] **Step 3: Implement `src/routes/parse.ts`**

```ts
export type PlexScrobble = {
  user: string; type: 'episode' | 'movie'; showRatingKey: string | null
  guids: { id: string }[]; grandparentTitle: string | null; title: string
  year: number | null; season: number | null; number: number | null
  viewCount: number; lastViewedAt: number | null
}

export type PulsarrEvent = {
  user: string; action: 'added' | 'removed'; title: string
  kind: 'show' | 'movie'; guids: { id: string }[]
}

export function parsePlexScrobble(form: FormData): PlexScrobble | null {
  const raw = form.get('payload')
  if (typeof raw !== 'string') return null
  let p: any
  try { p = JSON.parse(raw) } catch { return null }
  if (p?.event !== 'media.scrobble') return null
  const m = p.Metadata ?? {}
  if (m.type !== 'episode' && m.type !== 'movie') return null
  return {
    user: p.Account?.title ?? '',
    type: m.type,
    showRatingKey: m.grandparentRatingKey != null ? String(m.grandparentRatingKey) : null,
    guids: Array.isArray(m.Guid) ? m.Guid : [],
    grandparentTitle: m.grandparentTitle ?? null,
    title: m.title ?? '',
    year: m.year != null ? Number(m.year) : null,
    season: m.parentIndex != null ? Number(m.parentIndex) : null,
    number: m.index != null ? Number(m.index) : null,
    viewCount: m.viewCount != null ? Number(m.viewCount) : 1,
    lastViewedAt: m.lastViewedAt != null ? Number(m.lastViewedAt) : null,
  }
}

export function parsePulsarr(body: unknown): PulsarrEvent | null {
  const b = body as any
  const ev = b?.event
  if (ev !== 'watchlist.added' && ev !== 'watchlist.removed') return null
  const c = b?.data?.content ?? {}
  const guids: { id: string }[] = (c.guids ?? []).map((g: string) =>
    ({ id: g.includes('://') ? g : g.replace(':', '://') }))
  return {
    user: b?.data?.addedBy?.username ?? '',
    action: ev === 'watchlist.added' ? 'added' : 'removed',
    title: c.title ?? '',
    kind: c.type === 'movie' ? 'movie' : 'show',
    guids,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/parse.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: plex multipart and pulsarr json webhook parsing"
```

---

### Task 11: Handlers — wire resolution, planning and writing together

**Files:**
- Create: `src/handlers.ts`
- Create: `src/notify.ts`
- Test: `tests/handlers.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 2–10
- Produces:
  - `type AppDeps = { config: Config; store: Store; auth: Auth; fetchImpl?: typeof fetch; newId?: () => string }`
  - `handlePlex(deps: AppDeps, s: PlexScrobble): Promise<{ status: 'ok' | 'ignored' | 'failed'; reason?: string }>`
  - `handlePulsarr(deps: AppDeps, e: PulsarrEvent): Promise<{ status: 'ok' | 'ignored' | 'failed'; reason?: string }>`
  - `notify(url: string | null, text: string): Promise<void>`

- [ ] **Step 1: Write `src/notify.ts` (no test — a three-line fire-and-forget)**

```ts
export async function notify(url: string | null, text: string): Promise<void> {
  console.warn('[notify]', text)
  if (!url) return
  try {
    await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch { /* notification failure must never fail the request */ }
}
```

- [ ] **Step 2: Write the failing handler test**

```ts
// tests/handlers.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { loadConfig } from '../src/config.js'
import { handlePlex, handlePulsarr } from '../src/handlers.js'

const fx = (n: string) => JSON.parse(readFileSync(`tests/fixtures/${n}.json`, 'utf8'))
let store: Store
beforeEach(() => { store = openStore(':memory:') })

const CONFIG = loadConfig({
  BINGERS_SESSION_COOKIE: 'TOK', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt', DRY_RUN: 'false',
} as NodeJS.ProcessEnv)

let n = 0
const newId = () => `id-${++n}`

function router(routes: [RegExp, unknown][]) {
  const calls: { url: string; init?: any }[] = []
  const f = vi.fn(async (url: string, init?: any) => {
    calls.push({ url, init })
    for (const [re, body] of routes) if (re.test(url)) return new Response(JSON.stringify(body), { status: 200 })
    return new Response('{}', { status: 404 })
  })
  return { f, calls }
}

const SCROBBLE = {
  user: 'plexuser', type: 'episode' as const, showRatingKey: '90363',
  guids: [{ id: 'tmdb://5175711' }], grandparentTitle: 'Tires', title: 'Sales Contest',
  year: 2024, season: 1, number: 3, viewCount: 1, lastViewedAt: 1789553428,
}

const ROUTES: [RegExp, unknown][] = [
  [/library\/metadata\/90363\?includeGuids/, { MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://247522' }] }] } }],
  [/allLeaves/, { MediaContainer: { Metadata: [
    { parentIndex: 1, index: 1, viewCount: 1, lastViewedAt: 1788000000 },
    { parentIndex: 1, index: 2 },
    { parentIndex: 1, index: 3, viewCount: 1, lastViewedAt: 1789553428 },
  ] } }],
  [/search\/titles/, fx('search-tires')],
  [/metadata@543408442fd2/, fx('metadata-tires')],
  [/versions\.json/, fx('versions-tires')],
  [/season-1@dddd00000004/, fx('season1-tires')],
  [/season-0@cccc00000003/, { episodes: [] }],
  [/me\/watches\?/, { watches: [{ id: 'w1', watchedAt: '2026-09-16T12:00:00.000Z' }] }],
  [/me\/watches\//, { entry: {} }],
  [/sync\/push/, { results: [], rows: {} }],
]

const deps = (f: any) => ({ config: CONFIG, store, auth: createAuth(store, 'TOK', 'UA'), fetchImpl: f as typeof fetch, newId })

describe('handlePlex', () => {
  it('ignores a scrobble from another user without writing', async () => {
    const { f } = router(ROUTES)
    const r = await handlePlex(deps(f), { ...SCROBBLE, user: 'someone-else' })
    expect(r.status).toBe('ignored')
    expect(f).not.toHaveBeenCalled()
  })

  it('resolves via the SHOW ids from plex, not the episode guids in the payload', async () => {
    const { f, calls } = router(ROUTES)
    const r = await handlePlex(deps(f), SCROBBLE)
    expect(r.status).toBe('ok')
    expect(calls.some(c => /library\/metadata\/90363\?includeGuids/.test(c.url))).toBe(true)
  })

  it('pushes the scrobbled episode and only plex-watched backfill episodes', async () => {
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    const push = calls.find(c => /sync\/push/.test(c.url))!
    const ops = JSON.parse(push.init.body).ops
    const ids = ops.filter((o: any) => o.table === 'entries').map((o: any) => o.pk.entityId)
    // E3 scrobbled, E1 watched in plex; E2 has viewCount 0 and must be absent
    expect(ids).toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f117')
    expect(ids).toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
    expect(ids).not.toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f111')
  })

  it('does not re-write an episode already watched on bingers', async () => {
    store.putSyncRows('entries', [{ pk: 'episode:019f6bb9-65fd-7ef3-8053-8e3333a9f110', row: { watched: true, deletedAt: null } }])
    const { f, calls } = router(ROUTES)
    await handlePlex(deps(f), SCROBBLE)
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    const ids = ops.filter((o: any) => o.table === 'entries').map((o: any) => o.pk.entityId)
    expect(ids).not.toContain('019f6bb9-65fd-7ef3-8053-8e3333a9f110')
  })

  it('records a failure and returns 200-shaped ok when nothing verifies', async () => {
    const { f } = router([
      [/library\/metadata\/90363\?includeGuids/, { MediaContainer: { Metadata: [{ Guid: [{ id: 'tmdb://000' }] }] } }],
      [/search\/titles/, fx('search-tires')],
      [/metadata@543408442fd2/, fx('metadata-tires')],
    ])
    const r = await handlePlex(deps(f), SCROBBLE)
    expect(r.status).toBe('failed')
    expect(store.listFailures()).toHaveLength(1)
  })
})

describe('handlePulsarr', () => {
  it('follows on added using the verified titleId', async () => {
    const { f, calls } = router([
      [/search\/titles/, { results: [{ id: 'M1', kind: 'show', metadata: 'h', card: { originalTitle: 'The Mentalist', titlesI18n: {}, year: 2008 } }] }],
      [/metadata@h/, { id: 'M1', title: 'The Mentalist', year: 2008, kind: 'show', external_ids: [{ id: '5920', source: 'tmdb' }] }],
      [/sync\/push/, { results: [], rows: {} }],
    ])
    const r = await handlePulsarr(deps(f), {
      user: 'plexuser', action: 'added', title: 'The Mentalist', kind: 'show', guids: [{ id: 'tmdb://5920' }],
    })
    expect(r.status).toBe('ok')
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    expect(ops[0]).toMatchObject({ table: 'follows', pk: { titleId: 'M1' }, fields: { kind: 'show' } })
  })

  it('uses op-level deleted on removed', async () => {
    store.putTitleMapping([{ source: 'tmdb', extId: '5920', kind: 'show', titleId: 'M1', title: null, year: null }])
    const { f, calls } = router([[/sync\/push/, { results: [], rows: {} }]])
    await handlePulsarr(deps(f), {
      user: 'plexuser', action: 'removed', title: 'The Mentalist', kind: 'show', guids: [{ id: 'tmdb://5920' }],
    })
    const ops = JSON.parse(calls.find(c => /sync\/push/.test(c.url))!.init.body).ops
    expect(ops[0].deleted).toBe(true)
    expect(ops[0].fields).toBeUndefined()
  })
})
```

- [ ] **Step 3: Run it and watch it fail**

Run: `npx vitest run tests/handlers.test.ts`
Expected: FAIL — cannot resolve `../src/handlers.js`

- [ ] **Step 4: Implement `src/handlers.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { Config } from './config.js'
import type { Store } from './store.js'
import type { Auth } from './bingers/auth.js'
import type { PlexScrobble, PulsarrEvent } from './routes/parse.js'
import { resolveTitle, resolveEpisode, type ExternalIds } from './resolve.js'
import { fetchShowIds, fetchAllLeaves, parseGuids } from './plex/client.js'
import { planScrobble, planWatchlist } from './plan.js'
import { pushOps, applyDates, type SyncDeps } from './bingers/sync.js'
import { notify } from './notify.js'

export type AppDeps = {
  config: Config; store: Store; auth: Auth
  fetchImpl?: typeof fetch; newId?: () => string
}
export type HandlerResult = { status: 'ok' | 'ignored' | 'failed'; reason?: string }

const iso = (unixSeconds: number | null) =>
  new Date((unixSeconds ?? Math.floor(Date.now() / 1000)) * 1000).toISOString()

function syncDeps(d: AppDeps): SyncDeps {
  return {
    auth: d.auth, store: d.store, userAgent: d.config.bingersUserAgent,
    dryRun: d.config.dryRun, watchDateToleranceSec: d.config.watchDateToleranceSec,
    fetchImpl: d.fetchImpl,
  }
}

function isFollowed(store: Store, titleId: string): boolean {
  const row = store.getSyncRow('follows', titleId)
  // A row with deletedAt set counts as NOT followed: a scrobble re-follows a
  // title you removed, matching the app's own "add to your list?" prompt.
  return !!row && !row.deletedAt
}

function alreadyWatched(store: Store, entityKind: string, entityId: string): boolean {
  const row = store.getSyncRow('entries', `${entityKind}:${entityId}`)
  return !!row && row.watched === true && !row.deletedAt
}

async function fail(d: AppDeps, source: string, reason: string, payload: unknown): Promise<HandlerResult> {
  d.store.recordFailure(source, reason, payload)
  await notify(d.config.notifyUrl, `${source}: ${reason}`)
  return { status: 'failed', reason }
}

export async function handlePlex(d: AppDeps, s: PlexScrobble): Promise<HandlerResult> {
  if (s.user !== d.config.allowedUser) return { status: 'ignored' }
  const newId = d.newId ?? randomUUID
  const rd = { store: d.store, fetchImpl: d.fetchImpl, searchMaxPages: d.config.searchMaxPages }
  const pd = { plexUrl: d.config.plexUrl, plexToken: d.config.plexToken, fetchImpl: d.fetchImpl }

  let ids: ExternalIds
  let searchTitle: string
  const kind = s.type === 'movie' ? 'movie' : 'show'

  if (s.type === 'movie') {
    ids = parseGuids(s.guids)
    searchTitle = s.title
  } else {
    if (!s.showRatingKey) return fail(d, 'plex', 'episode scrobble without grandparentRatingKey', s)
    try {
      ids = await fetchShowIds(pd, s.showRatingKey)
    } catch (e) {
      return fail(d, 'plex', `plex show lookup failed: ${(e as Error).message}`, s)
    }
    searchTitle = s.grandparentTitle ?? s.title
  }

  const t = await resolveTitle(rd, { title: searchTitle, kind, ids })
  if ('failure' in t) return fail(d, 'plex', t.failure, s)

  let entityId = t.titleId
  if (s.type === 'episode') {
    if (s.season == null || s.number == null) return fail(d, 'plex', 'episode scrobble without season/number', s)
    const e = await resolveEpisode({ ...rd, catalogTtlHours: d.config.catalogTtlHours },
      { titleId: t.titleId, season: s.season, number: s.number })
    if ('failure' in e) return fail(d, 'plex', e.failure, s)
    entityId = e.episodeId
  }

  const backfill: { episodeId: string; plays: number; watchedAt: string }[] = []
  if (s.type === 'episode') {
    try {
      const leaves = await fetchAllLeaves(pd, s.showRatingKey!)
      for (const l of leaves) {
        if (l.viewCount < 1) continue
        const epId = d.store.getEpisodeId(t.titleId, l.season, l.number)
        if (!epId || epId === entityId) continue
        if (alreadyWatched(d.store, 'episode', epId)) continue
        backfill.push({ episodeId: epId, plays: l.viewCount, watchedAt: iso(l.lastViewedAt) })
      }
    } catch { /* backfill is best-effort; the scrobble itself still lands */ }
  }

  const plan = planScrobble({
    titleId: t.titleId, kind, entityKind: s.type, entityId,
    plays: Math.max(1, s.viewCount), watchedAt: iso(s.lastViewedAt),
    isFollowed: isFollowed(d.store, t.titleId), backfill, newId,
  })

  await pushOps(syncDeps(d), plan.ops)
  await applyDates(syncDeps(d), plan.dated)
  return { status: 'ok' }
}

export async function handlePulsarr(d: AppDeps, e: PulsarrEvent): Promise<HandlerResult> {
  if (e.user !== d.config.allowedUser) return { status: 'ignored' }
  const newId = d.newId ?? randomUUID
  const rd = { store: d.store, fetchImpl: d.fetchImpl, searchMaxPages: d.config.searchMaxPages }

  const t = await resolveTitle(rd, { title: e.title, kind: e.kind, ids: parseGuids(e.guids) })
  if ('failure' in t) return fail(d, 'pulsarr', t.failure, e)

  const plan = planWatchlist({ titleId: t.titleId, kind: e.kind, action: e.action, newId })
  await pushOps(syncDeps(d), plan.ops)
  return { status: 'ok' }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/handlers.test.ts`
Expected: PASS, 7 tests

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: plex and pulsarr handlers wiring resolve, plan and push"
```

---

### Task 12: Outbox retry and write-halt on 401

The `outbox` table exists in the schema from Task 2 but has no consumer yet.
Transient failures (Bingers 5xx, network) must survive a restart and retry with
backoff; a 401 must stop writing without losing queued work.

**Files:**
- Modify: `src/store.ts` (append outbox methods to the returned object)
- Create: `src/outbox.ts`
- Modify: `src/handlers.ts` (Step 6 — `AppDeps.gate`, write through `submit`)
- Modify: `tests/handlers.test.ts` (Step 6 — pass `gate` in the deps helper)
- Test: `tests/outbox.test.ts`

**Interfaces:**
- Consumes: `Store` (Task 2), `pushOps`/`SyncDeps` (Task 9), `Op` (Task 7)
- Produces:
  - Store additions: `enqueueOps(ops: Op[]): void`, `dueOps(nowIso: string, limit?: number): Op[]`, `markApplied(opIds: string[]): void`, `reschedule(opId: string, nextTryAt: string): void`, `outboxDepth(): number`
  - `createGate(): { halted: boolean; halt(reason: string): void; clear(): void }`
  - `submit(deps: SyncDeps, gate: Gate, ops: Op[]): Promise<'sent' | 'queued' | 'halted'>`
  - `flushOutbox(deps: SyncDeps, gate: Gate): Promise<number>` — returns ops applied
  - `backoffMs(attempts: number): number` — `min(60_000 * 2 ** attempts, 3_600_000)`

- [ ] **Step 1: Write the failing test**

```ts
// tests/outbox.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { createGate, submit, flushOutbox, backoffMs } from '../src/outbox.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const OP = (id: string) => ({
  opId: id, table: 'entries' as const,
  pk: { entityKind: 'episode' as const, entityId: 'E' + id },
  fields: { watched: true as const, plays: 1, batchId: null },
})
const mk = (f: any) => ({
  auth: createAuth(store, 'TOK', 'UA'), store, userAgent: 'UA',
  dryRun: false, watchDateToleranceSec: 120, fetchImpl: f as typeof fetch,
})
const ok = () => vi.fn(async () => new Response(JSON.stringify({ results: [], rows: {} }), { status: 200 }))
const boom = (status: number) => vi.fn(async () => new Response('{}', { status }))

describe('backoffMs', () => {
  it('grows exponentially and caps at an hour', () => {
    expect(backoffMs(0)).toBe(60_000)
    expect(backoffMs(3)).toBe(480_000)
    expect(backoffMs(99)).toBe(3_600_000)
  })
})

describe('submit', () => {
  it('sends when healthy and queues nothing', async () => {
    const r = await submit(mk(ok()), createGate(), [OP('1')])
    expect(r).toBe('sent')
    expect(store.outboxDepth()).toBe(0)
  })

  it('queues the ops when bingers returns 500', async () => {
    const r = await submit(mk(boom(500)), createGate(), [OP('1')])
    expect(r).toBe('queued')
    expect(store.outboxDepth()).toBe(1)
  })

  it('halts the gate on 401 and still queues rather than dropping work', async () => {
    const gate = createGate()
    const r = await submit(mk(boom(401)), gate, [OP('1')])
    expect(r).toBe('halted')
    expect(gate.halted).toBe(true)
    expect(store.outboxDepth()).toBe(1)
  })

  it('queues without sending once halted', async () => {
    const gate = createGate(); gate.halt('401')
    const f = ok()
    expect(await submit(mk(f), gate, [OP('2')])).toBe('halted')
    expect(f).not.toHaveBeenCalled()
    expect(store.outboxDepth()).toBe(1)
  })
})

describe('flushOutbox', () => {
  it('drains queued ops once bingers recovers', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1'), OP('2')])
    expect(store.outboxDepth()).toBe(2)
    const n = await flushOutbox(mk(ok()), createGate())
    expect(n).toBe(2)
    expect(store.outboxDepth()).toBe(0)
  })

  it('does nothing while the gate is halted', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1')])
    const gate = createGate(); gate.halt('401')
    const f = ok()
    expect(await flushOutbox(mk(f), gate)).toBe(0)
    expect(f).not.toHaveBeenCalled()
    expect(store.outboxDepth()).toBe(1)
  })

  it('reschedules rather than dropping when the retry also fails', async () => {
    await submit(mk(boom(500)), createGate(), [OP('1')])
    const n = await flushOutbox(mk(boom(503)), createGate())
    expect(n).toBe(0)
    expect(store.outboxDepth()).toBe(1)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/outbox.test.ts`
Expected: FAIL — cannot resolve `../src/outbox.js`

- [ ] **Step 3: Append outbox methods to the object returned by `openStore` in `src/store.ts`**

Insert these before the closing `close()` method:

```ts
    enqueueOps(ops: { opId: string; table: string; pk: unknown; [k: string]: unknown }[]) {
      const st = db.prepare(`INSERT INTO outbox (op_id, batch_id, table_name, pk_json, fields_json, attempts, next_try_at, status, created_at)
        VALUES (?,?,?,?,?,0,?, 'pending', ?) ON CONFLICT(op_id) DO NOTHING`)
      const t = now()
      db.transaction(() => {
        for (const o of ops) {
          const { opId, table, pk, ...rest } = o as any
          st.run(opId, (rest.fields?.batchId ?? null), table, JSON.stringify(pk), JSON.stringify(rest), t, t)
        }
      })()
    },
    dueOps(nowIso: string, limit = 50) {
      const rows = db.prepare(`SELECT op_id, table_name, pk_json, fields_json FROM outbox
        WHERE status='pending' AND (next_try_at IS NULL OR next_try_at <= ?) ORDER BY created_at LIMIT ?`)
        .all(nowIso, limit) as { op_id: string; table_name: string; pk_json: string; fields_json: string }[]
      return rows.map(r => ({ opId: r.op_id, table: r.table_name, pk: JSON.parse(r.pk_json), ...JSON.parse(r.fields_json) })) as any[]
    },
    markApplied(opIds: string[]) {
      const st = db.prepare("UPDATE outbox SET status='applied' WHERE op_id=?")
      db.transaction(() => { for (const id of opIds) st.run(id) })()
    },
    reschedule(opId: string, nextTryAt: string) {
      db.prepare('UPDATE outbox SET attempts = attempts + 1, next_try_at = ? WHERE op_id = ?').run(nextTryAt, opId)
    },
    attemptsFor(opId: string): number {
      const r = db.prepare('SELECT attempts FROM outbox WHERE op_id=?').get(opId) as { attempts: number } | undefined
      return r?.attempts ?? 0
    },
    outboxDepth(): number {
      const r = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status='pending'").get() as { n: number }
      return r.n
    },
```

- [ ] **Step 4: Implement `src/outbox.ts`**

```ts
import type { Op } from './plan.js'
import { pushOps, type SyncDeps } from './bingers/sync.js'

export type Gate = { halted: boolean; reason: string | null; halt(reason: string): void; clear(): void }

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

export async function submit(deps: SyncDeps, gate: Gate, ops: Op[]): Promise<'sent' | 'queued' | 'halted'> {
  if (ops.length === 0) return 'sent'
  if (gate.halted) { deps.store.enqueueOps(ops as any); return 'halted' }
  try {
    await pushOps(deps, ops)
    return 'sent'
  } catch (e) {
    const msg = (e as Error).message
    deps.store.enqueueOps(ops as any)
    if (msg.includes('401')) { gate.halt(msg); return 'halted' }
    return 'queued'
  }
}

export async function flushOutbox(deps: SyncDeps, gate: Gate): Promise<number> {
  if (gate.halted) return 0
  const due = deps.store.dueOps(new Date().toISOString())
  if (due.length === 0) return 0
  try {
    await pushOps(deps, due as Op[])
    deps.store.markApplied(due.map(o => o.opId))
    return due.length
  } catch (e) {
    const msg = (e as Error).message
    if (msg.includes('401')) gate.halt(msg)
    for (const o of due) {
      const next = new Date(Date.now() + backoffMs(deps.store.attemptsFor(o.opId))).toISOString()
      deps.store.reschedule(o.opId, next)
    }
    return 0
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/outbox.test.ts`
Expected: PASS, 8 tests

- [ ] **Step 6: Route handler writes through the gate**

In `src/handlers.ts`, add `gate: Gate` to `AppDeps`, replace both `await pushOps(syncDeps(d), plan.ops)` calls with `await submit(syncDeps(d), d.gate, plan.ops)`, and skip `applyDates` when the submit result is not `'sent'` (there is nothing to date-correct if nothing was written):

```ts
const outcome = await submit(syncDeps(d), d.gate, plan.ops)
if (outcome === 'sent') await applyDates(syncDeps(d), plan.dated)
```

Update `tests/handlers.test.ts`'s `deps()` helper to pass `gate: createGate()`.

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: outbox retry with backoff and write-halt on 401"
```

---

### Task 13: HTTP server, schedulers, Docker

**Files:**
- Create: `src/server.ts`, `Dockerfile`, `docker-compose.yml`, `README.md`
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `handlePlex`/`handlePulsarr` (Task 11), `pullOnce` (Task 9), `Auth.heartbeat` (Task 8)
- Produces: `createApp(deps: AppDeps): Hono` — routes `POST /plex`, `POST /pulsarr`, `GET /health`

- [ ] **Step 1: Write the failing test**

```ts
// tests/server.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { loadConfig } from '../src/config.js'
import { createApp } from '../src/server.js'
import { createGate } from '../src/outbox.js'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const CONFIG = loadConfig({
  BINGERS_SESSION_COOKIE: 'TOK', PLEX_URL: 'http://plex', PLEX_TOKEN: 'pt',
} as NodeJS.ProcessEnv) // DRY_RUN defaults true

const app = () => createApp({
  config: CONFIG, store, auth: createAuth(store, 'TOK', 'UA'), gate: createGate(),
  fetchImpl: vi.fn(async () => new Response('{}', { status: 404 })) as any,
})

describe('routes', () => {
  it('reports health', async () => {
    const res = await app().request('/health')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true, dryRun: true, writesHalted: false, outboxDepth: 0 })
  })

  it('accepts a plex multipart post and returns 200', async () => {
    const f = new FormData()
    f.set('payload', JSON.stringify({ event: 'media.scrobble', Account: { title: 'someone-else' }, Metadata: { type: 'episode' } }))
    const res = await app().request('/plex', { method: 'POST', body: f })
    expect(res.status).toBe(200)
  })

  it('returns 200 even for an unparseable plex body so plex does not retry', async () => {
    const res = await app().request('/plex', { method: 'POST', body: new FormData() })
    expect(res.status).toBe(200)
  })

  it('accepts pulsarr json and returns 200', async () => {
    const res = await app().request('/pulsarr', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'watchlist.added', data: { addedBy: { username: 'nobody' }, content: { title: 'x', type: 'show', guids: [] } } }),
    })
    expect(res.status).toBe(200)
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — cannot resolve `../src/server.js`

- [ ] **Step 3: Implement `src/server.ts`**

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS, 4 tests

- [ ] **Step 5: Add `Dockerfile` and `docker-compose.yml`**

```dockerfile
FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
VOLUME /data
CMD ["node", "dist/server.js"]
```

```yaml
services:
  bingers-sync:
    build: .
    restart: unless-stopped
    ports: ["8787:8787"]
    env_file: .env
    volumes: ["./data:/data"]
```

- [ ] **Step 6: Write `README.md`**

```markdown
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
```

- [ ] **Step 7: Run the whole suite**

Run: `npx vitest run`
Expected: PASS — all tests across all 13 tasks

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: http server, sync and heartbeat schedulers, docker packaging"
```

---

### Task 14: Live verification against the real account

This task has no unit tests — it is the controlled first contact with production.

- [ ] **Step 1: Build and start in dry run**

```bash
cp .env.example .env    # fill in the three secrets
docker compose up -d --build
curl -s localhost:8787/health | jq
```

Expected: `{"ok":true,"dryRun":true,...}` and a non-null `sessionDaysRemaining`.

- [ ] **Step 2: Replay the reference Plex payload**

```bash
curl -s -X POST localhost:8787/plex \
  -F 'payload={"event":"media.scrobble","Account":{"title":"plexuser"},"Metadata":{"type":"episode","grandparentRatingKey":"90363","grandparentTitle":"Tires","title":"Sales Contest","parentIndex":1,"index":3,"year":2024,"viewCount":1,"lastViewedAt":1789553428,"Guid":[{"id":"tmdb://5175711"}]}}'
docker compose logs --tail=50 bingers-sync
```

Expected: `[DRY_RUN] would POST /sync/push` with an `entries` op whose `entityId` is a Bingers UUID, and any backfill ops sharing one `batchId`.

- [ ] **Step 3: Confirm the resolution actually cached**

```bash
sqlite3 ./data/bingers-sync.db 'SELECT source, ext_id, title_id, title FROM title_map;'
sqlite3 ./data/bingers-sync.db 'SELECT COUNT(*) FROM episode_map;'
```

Expected: tmdb/tvdb/imdb rows for Tires, and a non-zero episode count.

- [ ] **Step 4: Go live for a single event**

Set `DRY_RUN=false`, `docker compose up -d`, replay the same payload, then confirm in the Bingers app that the episode shows as watched with the **correct date** (2026-09-16, from `lastViewedAt`) rather than the moment you ran the command.

- [ ] **Step 5: Point the real webhooks at it**

Plex → Settings → Webhooks → `http://<host>:8787/plex`. Pulsarr → `http://<host>:8787/pulsarr`.

- [ ] **Step 6: Check the session question answers itself**

After 24–48 hours:

```bash
sqlite3 ./data/bingers-sync.db 'SELECT expires_at, rotated_at, checked_at FROM auth_state;'
```

If `expires_at` has moved past `2027-09-16T08:20:14.792Z`, the session is rolling and needs no further attention. If it is unchanged, it is a fixed annual session and the 30-day warning applies.

- [ ] **Step 7: Commit any fixes found during live verification**

```bash
git add -A
git commit -m "fix: corrections from live verification"
```
