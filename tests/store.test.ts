import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
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

  it('upserts rather than throwing on a repeated episode', () => {
    const ep = { titleId: 'T1', season: 1, number: 3, episodeId: 'E3', abs: 3, title: 'Old Title', aired: '2024-05-23', seasonHash: 'h1' }
    s.putEpisodes([ep])
    s.putEpisodes([{ ...ep, episodeId: 'E3_NEW', title: 'New Title' }])
    expect(s.getEpisodeId('T1', 1, 3)).toBe('E3_NEW')
  })
})

describe('sync_state', () => {
  it('stores and returns parsed rows', () => {
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', deletedAt: null } }])
    expect(s.getSyncRow('follows', 'T1')).toEqual({ titleId: 'T1', deletedAt: null })
    expect(s.getSyncRow('follows', 'T2')).toBeNull()
  })

  it('upserts rather than throwing on a repeated sync row', () => {
    const row = { pk: 'T1', row: { titleId: 'T1', deletedAt: null } }
    s.putSyncRows('follows', [row])
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', deletedAt: '2026-09-16' } }])
    expect(s.getSyncRow('follows', 'T1')).toEqual({ titleId: 'T1', deletedAt: '2026-09-16' })
  })
})

describe('cursors and failures', () => {
  it('stores cursors', () => {
    expect(s.getCursor('follows')).toBeNull()
    s.setCursor('follows', '2026-09-16T10:00:00Z')
    expect(s.getCursor('follows')).toBe('2026-09-16T10:00:00Z')
  })

  it('upserts rather than throwing on a repeated cursor', () => {
    s.setCursor('follows', '2026-09-16T10:00:00Z')
    s.setCursor('follows', '2026-09-16T11:00:00Z')
    expect(s.getCursor('follows')).toBe('2026-09-16T11:00:00Z')
  })

  it('records failures with their payload', () => {
    s.recordFailure('plex', 'no external id match', { title: 'Tires' })
    const f = s.listFailures()
    expect(f).toHaveLength(1)
    expect(f[0]!.reason).toBe('no external id match')
    expect(JSON.parse(f[0]!.payload).title).toBe('Tires')
  })
})

describe('catalog_version', () => {
  it('round-trips catalog version with files JSON parsed correctly', () => {
    const files = { 'path/to/file.mkv': { size: 1024 } }
    s.putCatalogVersion('T1', files)
    const result = s.getCatalogVersion('T1')
    expect(result).not.toBeNull()
    expect(result!.files).toEqual(files)
    expect(result!.fetchedAt).toBeDefined()
  })

  it('returns null on cache miss', () => {
    expect(s.getCatalogVersion('T1')).toBeNull()
  })

  it('upserts rather than throwing on a repeated catalog version', () => {
    const files1 = { 'file1.mkv': { size: 1024 } }
    const files2 = { 'file2.mkv': { size: 2048 } }
    s.putCatalogVersion('T1', files1)
    s.putCatalogVersion('T1', files2)
    const result = s.getCatalogVersion('T1')
    expect(result!.files).toEqual(files2)
  })

  it('advances fetched_at on a repeated write', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-16T10:00:00.000Z'))
      s.putCatalogVersion('T1', { 'file1.mkv': { size: 1024 } })
      const first = s.getCatalogVersion('T1')!.fetchedAt

      vi.setSystemTime(new Date('2026-09-16T11:00:00.000Z'))
      s.putCatalogVersion('T1', { 'file2.mkv': { size: 2048 } })
      const second = s.getCatalogVersion('T1')!.fetchedAt

      expect(second).not.toBe(first)
      expect(new Date(second).getTime()).toBeGreaterThan(new Date(first).getTime())
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('auth_state', () => {
  it('round-trips auth state with all fields', () => {
    const auth: typeof import('../src/store.js').AuthState = {
      cookie: 'session_id=abc123',
      expiresAt: '2026-09-30T00:00:00Z',
      rotatedAt: '2026-09-16T00:00:00Z',
      checkedAt: '2026-09-16T12:00:00Z',
    }
    s.putAuthState(auth)
    const result = s.getAuthState()
    expect(result).toEqual(auth)
  })

  it('returns null on auth state miss', () => {
    expect(s.getAuthState()).toBeNull()
  })

  it('upserts rather than throwing on a repeated auth state (singleton check)', () => {
    const auth1 = {
      cookie: 'old_session',
      expiresAt: null,
      rotatedAt: null,
      checkedAt: null,
    }
    const auth2 = {
      cookie: 'new_session',
      expiresAt: '2026-09-30T00:00:00Z',
      rotatedAt: '2026-09-16T00:00:00Z',
      checkedAt: '2026-09-16T12:00:00Z',
    }
    s.putAuthState(auth1)
    s.putAuthState(auth2)
    const result = s.getAuthState()
    expect(result).toEqual(auth2)
    expect(result!.cookie).toBe('new_session')
  })
})

describe('mirror freshness marker', () => {
  it('is null until a pull has actually succeeded', () => {
    expect(s.getMirrorSyncedAt()).toBeNull()
  })

  it('round-trips and overwrites the last successful pull time', () => {
    s.markMirrorSynced('2026-09-16T10:00:00.000Z')
    expect(s.getMirrorSyncedAt()).toBe('2026-09-16T10:00:00.000Z')
    s.markMirrorSynced('2026-09-16T11:00:00.000Z')
    expect(s.getMirrorSyncedAt()).toBe('2026-09-16T11:00:00.000Z')
  })

  it('does not collide with a server stream cursor', () => {
    s.setCursor('entries', 'c1')
    s.markMirrorSynced('2026-09-16T10:00:00.000Z')
    expect(s.getCursor('entries')).toBe('c1')
  })
})

describe('close', () => {
  it('closes the underlying database connection', () => {
    s.setCursor('follows', 'c1')
    s.close()
    expect(() => s.getCursor('follows')).toThrow()
  })
})

describe('outbox watch dates', () => {
  const OP = (id: string, entityId: string) => ({
    opId: id, table: 'entries', pk: { entityKind: 'episode', entityId },
    fields: { watched: true, plays: 1, batchId: null },
  })

  it('persists the intended watch time alongside a queued op', () => {
    s.enqueueOps([OP('o1', 'E1'), OP('o2', 'E2')] as any,
      [{ entityKind: 'episode', entityId: 'E1', watchedAt: '2026-08-29T10:40:00.000Z' }])
    expect(s.watchedAtFor(['o1', 'o2'])).toEqual({ o1: '2026-08-29T10:40:00.000Z' })
  })

  it('keeps the watch time out of the op payload so nothing new reaches the wire', () => {
    s.enqueueOps([OP('o1', 'E1')] as any,
      [{ entityKind: 'episode', entityId: 'E1', watchedAt: '2026-08-29T10:40:00.000Z' }])
    const [rt] = s.dueOps(new Date().toISOString())
    expect(rt).toEqual(OP('o1', 'E1'))
    expect('watchedAt' in rt!).toBe(false)
  })

  it('returns an empty map for ops with no recorded date', () => {
    s.enqueueOps([OP('o1', 'E1')] as any)
    expect(s.watchedAtFor(['o1'])).toEqual({})
    expect(s.watchedAtFor([])).toEqual({})
  })
})

// The schema is created with CREATE TABLE IF NOT EXISTS, so a column added
// after the first release never appears on a database that already exists.
describe('outbox schema migration on an existing database', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'bingers-store-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('adds watched_at to an outbox table created before the column existed', () => {
    const path = join(dir, 'legacy.db')
    // Exactly the pre-change table definition.
    const legacy = new Database(path)
    legacy.exec(`CREATE TABLE outbox (
      op_id TEXT PRIMARY KEY, batch_id TEXT, table_name TEXT NOT NULL,
      pk_json TEXT NOT NULL, fields_json TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0, next_try_at TEXT,
      status TEXT NOT NULL, created_at TEXT NOT NULL)`)
    legacy.prepare(`INSERT INTO outbox VALUES ('old1', null, 'entries', '{"entityKind":"episode","entityId":"E9"}', '{"fields":{"watched":true,"plays":1,"batchId":null}}', 0, null, 'pending', '2026-09-01T00:00:00.000Z')`).run()
    legacy.close()

    const store = openStore(path)
    // The pre-existing queued op survives and still flushes...
    expect(store.outboxDepth()).toBe(1)
    expect(store.dueOps(new Date().toISOString())[0]?.opId).toBe('old1')
    expect(store.watchedAtFor(['old1'])).toEqual({})
    // ...and new ops can record a watch date.
    store.enqueueOps([{ opId: 'new1', table: 'entries', pk: { entityKind: 'episode', entityId: 'E1' }, fields: {} }] as any,
      [{ entityKind: 'episode', entityId: 'E1', watchedAt: '2026-08-29T10:40:00.000Z' }])
    expect(store.watchedAtFor(['new1'])).toEqual({ new1: '2026-08-29T10:40:00.000Z' })
    store.close()

    // Re-opening is idempotent: the guarded ALTER must not throw a second time.
    const again = openStore(path)
    expect(again.watchedAtFor(['new1'])).toEqual({ new1: '2026-08-29T10:40:00.000Z' })
    again.close()
  })
})
