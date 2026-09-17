import Database from 'better-sqlite3'

export type TitleMapping = { source: string; extId: string; kind: string; titleId: string; title: string | null; year: number | null }
export type EpisodeMapping = { titleId: string; season: number; number: number; episodeId: string; abs: number | null; title: string | null; aired: string | null; seasonHash: string }
export type AuthState = {
  cookie: string; expiresAt: string | null; rotatedAt: string | null; checkedAt: string | null
  // The Bingers account the session belongs to. /setup binds to the first one
  // it sees and refuses a link for any other, so a container cannot be
  // re-pointed at someone else's account by whoever reaches the port first.
  accountId: string | null
}
export type FailureRow = { id: number; source: string; reason: string; payload: string; created_at: string }
export type RatingOrigin = 'plex' | 'bingers'
export type RatingLink = { entityKind: 'episode' | 'movie'; entityId: string; bingersRating: number | null; plexRating: number | null; plexRatingKey: string | null; origin: RatingOrigin; updatedAt: string }
/**
 * 'added'      the title is on the plex watchlist and linked to a ratingKey
 * 'unresolved' discover was reached and gave no verifiable match -- a real,
 *              confirmed miss, retried on the long `reverseBackoffMs` curve
 * 'deferred'   the cycle could not decide (catalogue outage, candidate lookup
 *              errored, bad PLEX_TOKEN). Nothing was ruled out, so it retries
 *              on the SHORT `reverseDeferBackoffMs` curve -- but it does hold
 *              a bounded retry of its own, so a permanently-deferring title
 *              cannot sit in every batch forever and starve the queue.
 */
export type PlexLinkState = 'added' | 'unresolved' | 'deferred'
// plex_link's ratingKey comes from the DISCOVER/watchlist-add flow (see
// reverse.ts) -- a different namespace from the `__plex_show:` cache below,
// which comes from a locally-scanned/scrobbled server ratingKey. Two stores,
// deliberately: neither substitutes for the other.
export type PlexLink = { titleId: string; ratingKey: string | null; state: PlexLinkState; attempts: number; nextTryAt: string | null; checkedAt: string }

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
  expires_at TEXT, rotated_at TEXT, checked_at TEXT, account_id TEXT);

CREATE TABLE IF NOT EXISTS plex_link (
  title_id TEXT PRIMARY KEY, rating_key TEXT, state TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, next_try_at TEXT, checked_at TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS rating_link (
  entity_kind TEXT NOT NULL, entity_id TEXT NOT NULL,
  bingers_rating INTEGER, plex_rating REAL, plex_rating_key TEXT,
  origin TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (entity_kind, entity_id));

CREATE TABLE IF NOT EXISTS unratable (
  plex_rating_key TEXT PRIMARY KEY, reason TEXT NOT NULL, noted_at TEXT NOT NULL);
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
  const authCols = (db.prepare('PRAGMA table_info(auth_state)').all() as { name: string }[]).map(c => c.name)
  if (!authCols.includes('account_id')) db.exec('ALTER TABLE auth_state ADD COLUMN account_id TEXT')
  // Rejections are counted SEPARATELY from `attempts`, which also ticks for
  // transport failures. Only an op bingers explicitly refused may be
  // abandoned; a long outage must never consume the cap for a write that was
  // never actually rejected.
  if (!outboxCols.includes('rejections')) db.exec('ALTER TABLE outbox ADD COLUMN rejections INTEGER NOT NULL DEFAULT 0')

  const now = () => new Date().toISOString()

  return {
    /**
     * Run several store writes as ONE atomic unit. better-sqlite3 nests via
     * SAVEPOINT, so a method that opens its own transaction (putSyncRows,
     * enqueueOps) composes correctly inside this. The callback must be
     * synchronous -- an `await` inside would commit before the awaited work
     * ran. Used where two writes describe a single event and a crash between
     * them would leave local state describing something that never happened.
     */
    tx<T>(fn: () => T): T {
      return db.transaction(fn)()
    },
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
    // Writing a follows row with `deletedAt` set also DROPS that title's
    // plex_link. Without this, the round trip "reverse adds it -> you remove it
    // from the watchlist -> pulsarr unfollows it on bingers -> you follow it
    // again" leaves a stale state='added' link behind: the title is on neither
    // the watchlist nor the reverse queue (dueUnlinkedTitles filters 'added'
    // out) and /health still counts it as linked. Clearing the link here rather
    // than at each call site means every writer of a deleted follows row --
    // sync/pull and the outbox mirror today, anything added later -- gets it,
    // in the same transaction as the row itself.
    putSyncRows(table: string, rows: { pk: string; row: unknown }[]) {
      const st = db.prepare(`INSERT INTO sync_state (table_name, pk, row_json, updated_at) VALUES (?,?,?,?)
        ON CONFLICT(table_name, pk) DO UPDATE SET row_json=excluded.row_json, updated_at=excluded.updated_at`)
      const unlink = db.prepare('DELETE FROM plex_link WHERE title_id=?')
      db.transaction(() => {
        for (const r of rows) {
          st.run(table, r.pk, JSON.stringify(r.row), now())
          if (table === 'follows' && (r.row as { deletedAt?: unknown } | null)?.deletedAt != null) unlink.run(r.pk)
        }
      })()
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
      const r = db.prepare('SELECT cookie, expires_at, rotated_at, checked_at, account_id FROM auth_state WHERE id=1').get() as
        | { cookie: string; expires_at: string | null; rotated_at: string | null; checked_at: string | null; account_id: string | null }
        | undefined
      return r
        ? { cookie: r.cookie, expiresAt: r.expires_at, rotatedAt: r.rotated_at, checkedAt: r.checked_at, accountId: r.account_id }
        : null
    },
    putAuthState(s: AuthState) {
      db.prepare(`INSERT INTO auth_state (id, cookie, expires_at, rotated_at, checked_at, account_id) VALUES (1,?,?,?,?,?)
        ON CONFLICT(id) DO UPDATE SET cookie=excluded.cookie, expires_at=excluded.expires_at,
          rotated_at=excluded.rotated_at, checked_at=excluded.checked_at, account_id=excluded.account_id`)
        .run(s.cookie, s.expiresAt, s.rotatedAt, s.checkedAt, s.accountId)
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
    // An EXPLICIT rejection by bingers -- the server answered and refused this
    // op. Deliberately not `attempts`, which also counts transport failures.
    recordRejection(opId: string) {
      db.prepare('UPDATE outbox SET rejections = rejections + 1 WHERE op_id = ?').run(opId)
    },
    rejectionsFor(opId: string): number {
      const r = db.prepare('SELECT rejections FROM outbox WHERE op_id=?').get(opId) as { rejections: number } | undefined
      return r?.rejections ?? 0
    },
    /**
     * A distinct TERMINAL status, never a delete: the op row stays for
     * inspection and replay, but leaves `pending`, so it stops being retried,
     * stops counting towards outboxDepth, and -- what motivated it -- stops
     * hasPendingRatingOp() locking its entity out of the bingers->plex
     * direction forever. Nothing ever moves a row back out of 'abandoned'
     * automatically; the recorded failure carries the payload to replay by hand.
     *
     * This applies to EVERY op, not only ratings: a plain watched/plays write
     * bingers refuses MAX_OP_REJECTIONS times is abandoned on the same rule.
     * An abandoned op is a user write this service has decided to stop trying
     * to deliver, so it is surfaced on /health as `abandonedOps` -- a safety
     * mechanism that acts without leaving an observable trace cannot be
     * trusted or debugged.
     */
    abandonOp(opId: string) {
      db.prepare("UPDATE outbox SET status='abandoned' WHERE op_id=?").run(opId)
    },
    abandonedDepth(): number {
      const r = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status='abandoned'").get() as { n: number }
      return r.n
    },
    outboxDepth(): number {
      const r = db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE status='pending'").get() as { n: number }
      return r.n
    },
    getPlexLink(titleId: string): PlexLink | null {
      const r = db.prepare('SELECT title_id, rating_key, state, attempts, next_try_at, checked_at FROM plex_link WHERE title_id=?')
        .get(titleId) as { title_id: string; rating_key: string | null; state: string; attempts: number; next_try_at: string | null; checked_at: string } | undefined
      return r ? { titleId: r.title_id, ratingKey: r.rating_key, state: r.state as PlexLink['state'],
                   attempts: r.attempts, nextTryAt: r.next_try_at, checkedAt: r.checked_at } : null
    },
    putPlexLink(l: Omit<PlexLink, 'checkedAt'>) {
      db.prepare(`INSERT INTO plex_link (title_id, rating_key, state, attempts, next_try_at, checked_at)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(title_id) DO UPDATE SET rating_key=excluded.rating_key, state=excluded.state,
          attempts=excluded.attempts, next_try_at=excluded.next_try_at, checked_at=excluded.checked_at`)
        .run(l.titleId, l.ratingKey, l.state, l.attempts, l.nextTryAt, now())
    },
    dueUnlinkedTitles(nowIso: string, limit: number): string[] {
      const rows = db.prepare(`
        SELECT s.pk AS title_id FROM sync_state s
        LEFT JOIN plex_link p ON p.title_id = s.pk
        WHERE s.table_name = 'follows'
          AND json_extract(s.row_json, '$.deletedAt') IS NULL
          AND (p.title_id IS NULL OR (p.state IN ('unresolved','deferred') AND (p.next_try_at IS NULL OR p.next_try_at <= ?)))
        ORDER BY s.updated_at LIMIT ?`).all(nowIso, limit) as { title_id: string }[]
      return rows.map(r => r.title_id)
    },
    externalIdsFor(titleId: string) {
      const rows = db.prepare('SELECT source, ext_id, title, year FROM title_map WHERE title_id=?')
        .all(titleId) as { source: string; ext_id: string; title: string | null; year: number | null }[]
      const ids: Record<string, string> = {}
      for (const r of rows) ids[r.source] = r.ext_id
      return { ids, title: rows[0]?.title ?? null, year: rows[0]?.year ?? null }
    },
    countPlexLinks(state: PlexLinkState): number {
      const r = db.prepare('SELECT COUNT(*) AS n FROM plex_link WHERE state=?').get(state) as { n: number }
      return r.n
    },
    getRatingLink(entityKind: string, entityId: string): RatingLink | null {
      const r = db.prepare(`SELECT entity_kind, entity_id, bingers_rating, plex_rating,
        plex_rating_key, origin, updated_at FROM rating_link WHERE entity_kind=? AND entity_id=?`)
        .get(entityKind, entityId) as any
      return r ? {
        entityKind: r.entity_kind, entityId: r.entity_id,
        bingersRating: r.bingers_rating, plexRating: r.plex_rating,
        plexRatingKey: r.plex_rating_key, origin: r.origin, updatedAt: r.updated_at,
      } : null
    },
    putRatingLink(l: Omit<RatingLink, 'updatedAt'>) {
      db.prepare(`INSERT INTO rating_link (entity_kind, entity_id, bingers_rating, plex_rating,
        plex_rating_key, origin, updated_at) VALUES (?,?,?,?,?,?,?)
        ON CONFLICT(entity_kind, entity_id) DO UPDATE SET
          bingers_rating=excluded.bingers_rating, plex_rating=excluded.plex_rating,
          plex_rating_key=excluded.plex_rating_key, origin=excluded.origin,
          updated_at=excluded.updated_at`)
        .run(l.entityKind, l.entityId, l.bingersRating, l.plexRating, l.plexRatingKey, l.origin, now())
    },
    // Is there a rating write for this entity that bingers has NOT confirmed?
    // src/outbox.ts only mirrors an op into sync_state once the server applies
    // it, so while one is pending the stored `rating` is what bingers held
    // BEFORE our push -- not what the user last chose. src/ratings/toPlex.ts's
    // Layer 1 needs that distinction: without it a queued plex->bingers push
    // makes a stale mirrored rating look like a deliberate bingers-side change
    // and licenses a write back over the plex half-star it came from.
    hasPendingRatingOp(entityKind: string, entityId: string): boolean {
      return !!db.prepare(`SELECT 1 FROM outbox WHERE status='pending' AND table_name='entries'
        AND json_extract(pk_json, '$.entityKind')=? AND json_extract(pk_json, '$.entityId')=?
        AND json_extract(fields_json, '$.fields.rating') IS NOT NULL`).get(entityKind, entityId)
    },
    // Re-marking REFRESHES noted_at rather than doing nothing on conflict: a
    // no-match re-checked past its TTL and still absent has just been
    // confirmed again, and that confirmation is what restarts the clock.
    // Without the refresh a re-checked entry would be re-checked every run.
    markUnratable(plexRatingKey: string, reason: string) {
      db.prepare(`INSERT INTO unratable (plex_rating_key, reason, noted_at) VALUES (?,?,?)
        ON CONFLICT(plex_rating_key) DO UPDATE SET reason=excluded.reason, noted_at=excluded.noted_at`)
        .run(plexRatingKey, reason, now())
    },
    /**
     * `staleBefore` (an ISO instant) makes the mark EXPIRE: an entry noted at
     * or before it reads as not-unratable, so the caller re-checks it. Some
     * marks are structural and never expire (bingers has no show-rating
     * concept, and no catalogue update changes that); others record only that
     * bingers' catalogue did not have an item YET, and that dataset gains
     * entries continuously. Omitting the argument asks the raw question, "is
     * there a mark at all".
     */
    isUnratable(plexRatingKey: string, staleBefore?: string): boolean {
      const r = db.prepare('SELECT noted_at FROM unratable WHERE plex_rating_key=?')
        .get(plexRatingKey) as { noted_at: string } | undefined
      if (!r) return false
      return staleBefore == null || r.noted_at > staleBefore
    },
    // Every non-deleted entries row bingers has a rating on, for the
    // bingers->plex direction to walk. `titleId` is only ever the movie's own
    // id here -- episodes don't carry a Plex-lookup key back to their parent
    // title from this row alone, so the caller treats a null titleId as "not
    // resolvable via title_map".
    ratedEntries(): { entityKind: 'episode' | 'movie'; entityId: string; rating: number; titleId: string | null }[] {
      const rows = db.prepare(`SELECT pk, row_json FROM sync_state WHERE table_name='entries'
        AND json_extract(row_json, '$.rating') IS NOT NULL
        AND json_extract(row_json, '$.deletedAt') IS NULL`).all() as { pk: string; row_json: string }[]
      const out: { entityKind: 'episode' | 'movie'; entityId: string; rating: number; titleId: string | null }[] = []
      for (const r of rows) {
        const row = JSON.parse(r.row_json)
        // row_json is untrusted stored JSON, not a typed value -- asserting
        // entityKind rather than checking it would let a malformed or
        // future-schema row become a typed lie that flows straight into a
        // plex write. Skip anything that isn't one of the two legal values.
        if (row.entityKind !== 'episode' && row.entityKind !== 'movie') continue
        const rating = Number(row.rating)
        if (!Number.isFinite(rating) || rating < 1 || rating > 5) continue
        out.push({
          entityKind: row.entityKind, entityId: row.entityId, rating,
          titleId: row.entityKind === 'movie' ? row.entityId : null,
        })
      }
      return out
    },
    // The show's LOCAL-server ratingKey, cached from a scrobble -- distinct
    // from plex_link above, which holds the DISCOVER-origin ratingKey. This
    // one is server-local and reassignable (a library rebuild, a repointed
    // PLEX_URL, a second server), so it is never trusted on read without
    // re-verifying it in the current run (see src/ratings/toPlex.ts).
    putShowRatingKey(titleId: string, ratingKey: string) {
      db.prepare('INSERT INTO cursors (name, value) VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value')
        .run(`__plex_show:${titleId}`, ratingKey)
    },
    showRatingKeyFor(titleId: string): string | null {
      const r = db.prepare('SELECT value FROM cursors WHERE name=?').get(`__plex_show:${titleId}`) as { value: string } | undefined
      return r?.value ?? null
    },
    // Discards a show's cached ratingKey after it has been PROVEN (via a
    // verified external-id mismatch, never a guess) to denote a different
    // show -- see src/ratings/toPlex.ts's leavesFor(). Never called to
    // "repair" the cache with a replacement key. The next scrobble for the
    // real show repopulates the entry correctly from the webhook.
    deleteShowRatingKey(titleId: string) {
      db.prepare('DELETE FROM cursors WHERE name=?').run(`__plex_show:${titleId}`)
    },
    episodePosition(episodeId: string): { titleId: string; season: number; number: number } | null {
      // episode_map's PRIMARY KEY is (title_id, season, number); the
      // episode_map_episode_id index is NOT unique, so the same episode_id
      // can legitimately sit under more than one row. Picking one via .get()
      // would silently guess which show owns it -- exactly the kind of
      // unverified guess this whole feature exists to avoid -- so an
      // ambiguous (or absent) match declines rather than picking arbitrarily.
      const rows = db.prepare('SELECT title_id, season, number FROM episode_map WHERE episode_id=?')
        .all(episodeId) as { title_id: string; season: number; number: number }[]
      if (rows.length !== 1) return null
      const r = rows[0]!
      return { titleId: r.title_id, season: r.season, number: r.number }
    },
    countRatingLinks(): number {
      const r = db.prepare('SELECT COUNT(*) AS n FROM rating_link').get() as { n: number }
      return r.n
    },
    close() { db.close() },
  }
}

export type Store = ReturnType<typeof openStore>
