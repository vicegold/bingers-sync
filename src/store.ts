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

// Name of the cursor row that records the last SUCCESSFUL sync/pull. It lives
// in `cursors` rather than in a new table so it survives on existing databases
// with no migration, and is double-underscored so it can never collide with a
// server stream name (follows/entries/catalog/prefs/settings).
export const MIRROR_CURSOR = '__mirror_synced_at'

// Per-show markers for the Plex allLeaves rate limit. Same reasoning as
// MIRROR_CURSOR: `cursors` needs no migration, and the double-underscored
// prefix cannot collide with a server stream name. Keyed by the PLEX show
// ratingKey, because the thing being limited is a call to Plex addressed by
// that key -- not by a Bingers titleId, which several Plex shows can share.
export const allLeavesFetchedCursor = (ratingKey: string) => `__allleaves_at:${ratingKey}`
export const allLeavesReconciledCursor = (ratingKey: string) => `__allleaves_done:${ratingKey}`

export type AllLeavesState = { fetchedAt: string | null; reconciledAt: string | null }

export function openStore(dbPath: string) {
  const db = new Database(dbPath)
  db.pragma('journal_mode = WAL')
  db.exec(SCHEMA)

  // SCHEMA uses CREATE TABLE IF NOT EXISTS, so a column added after the first
  // release never appears on an existing database. Add it explicitly, guarded
  // by the live column list so this is safe to run on every boot.
  const outboxCols = (db.prepare('PRAGMA table_info(outbox)').all() as { name: string }[]).map(c => c.name)
  if (!outboxCols.includes('watched_at')) db.exec('ALTER TABLE outbox ADD COLUMN watched_at TEXT')

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
    // Mirror freshness. `null` means sync/pull has never once succeeded, which
    // is NOT the same as "the mirror says you have watched nothing" -- every
    // read of sync_state that infers absence (backfill, auto-follow) has to
    // know the difference.
    getMirrorSyncedAt(): string | null {
      const r = db.prepare('SELECT value FROM cursors WHERE name=?').get(MIRROR_CURSOR) as { value: string } | undefined
      return r?.value ?? null
    },
    markMirrorSynced(at?: string) {
      db.prepare('INSERT INTO cursors (name, value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
        .run(MIRROR_CURSOR, at ?? now())
    },

    // When allLeaves was last actually fetched for a show, and whether the
    // last scan left the show fully reconciled (nothing Plex reported watched
    // was missing from Bingers). Both are read by the backfill rate limit;
    // `fetchedAt` is only ever written after a fetch that really happened.
    getAllLeavesState(ratingKey: string): AllLeavesState {
      const st = db.prepare('SELECT value FROM cursors WHERE name=?')
      const a = st.get(allLeavesFetchedCursor(ratingKey)) as { value: string } | undefined
      const b = st.get(allLeavesReconciledCursor(ratingKey)) as { value: string } | undefined
      return { fetchedAt: a?.value ?? null, reconciledAt: b?.value ?? null }
    },
    markAllLeavesFetched(ratingKey: string, at?: string) {
      db.prepare('INSERT INTO cursors (name, value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
        .run(allLeavesFetchedCursor(ratingKey), at ?? now())
    },
    // `false` DELETES the marker: a show that has fallen out of reconciliation
    // must look exactly like one that was never reconciled.
    setAllLeavesReconciled(ratingKey: string, reconciled: boolean, at?: string) {
      const name = allLeavesReconciledCursor(ratingKey)
      if (!reconciled) { db.prepare('DELETE FROM cursors WHERE name=?').run(name); return }
      db.prepare('INSERT INTO cursors (name, value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
        .run(name, at ?? now())
    },
    recordFailure(source: string, reason: string, payload: unknown) {
      db.prepare('INSERT INTO failures (source, reason, payload, created_at) VALUES (?,?,?,?)')
        .run(source, reason, JSON.stringify(payload), now())
    },
    listFailures(limit = 100): FailureRow[] {
      return db.prepare('SELECT * FROM failures ORDER BY id DESC LIMIT ?').all(limit) as FailureRow[]
    },
    getAuthState(): AuthState | null {
      const r = db.prepare('SELECT cookie, expires_at, rotated_at, checked_at FROM auth_state WHERE id=1').get() as
        | { cookie: string; expires_at: string | null; rotated_at: string | null; checked_at: string | null }
        | undefined
      return r ? { cookie: r.cookie, expiresAt: r.expires_at, rotatedAt: r.rotated_at, checkedAt: r.checked_at } : null
    },
    putAuthState(s: AuthState) {
      db.prepare(`INSERT INTO auth_state (id, cookie, expires_at, rotated_at, checked_at) VALUES (1,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET cookie=excluded.cookie, expires_at=excluded.expires_at,
          rotated_at=excluded.rotated_at, checked_at=excluded.checked_at`)
        .run(s.cookie, s.expiresAt, s.rotatedAt, s.checkedAt)
    },
    // `dated` carries the REAL watch time each entries op should end up with.
    // It is stored in its own column rather than inside fields_json so the op
    // payload round-trips byte-identically and no invented key ever reaches
    // the wire on a later flush.
    enqueueOps(
      ops: { opId: string; table: string; pk: unknown; [k: string]: unknown }[],
      dated: { entityKind: string; entityId: string; watchedAt: string }[] = [],
    ) {
      const byEntity = new Map(dated.map(d => [`${d.entityKind}:${d.entityId}`, d.watchedAt]))
      const st = db.prepare(`INSERT INTO outbox (op_id, batch_id, table_name, pk_json, fields_json, attempts, next_try_at, status, created_at, watched_at)
        VALUES (?,?,?,?,?,0,?, 'pending', ?, ?) ON CONFLICT(op_id) DO NOTHING`)
      const t = now()
      db.transaction(() => {
        for (const o of ops) {
          const { opId, table, pk, ...rest } = o as any
          const p = pk as { entityKind?: string; entityId?: string } | null
          const watchedAt = (table === 'entries' && p?.entityKind && p?.entityId)
            ? byEntity.get(`${p.entityKind}:${p.entityId}`) ?? null
            : null
          st.run(opId, (rest.fields?.batchId ?? null), table, JSON.stringify(pk), JSON.stringify(rest), t, t, watchedAt)
        }
      })()
    },
    // Intended watch times for a set of queued ops, keyed by opId. Used after a
    // flush lands so the dated half of the original Plan is not lost.
    watchedAtFor(opIds: string[]): Record<string, string> {
      const out: Record<string, string> = {}
      if (opIds.length === 0) return out
      const st = db.prepare('SELECT op_id, watched_at FROM outbox WHERE op_id=?')
      for (const id of opIds) {
        const r = st.get(id) as { op_id: string; watched_at: string | null } | undefined
        if (r?.watched_at) out[r.op_id] = r.watched_at
      }
      return out
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
    close() { db.close() },
  }
}

export type Store = ReturnType<typeof openStore>
