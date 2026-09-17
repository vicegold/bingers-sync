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

describe('episodePosition', () => {
  it('resolves an episode id to its (titleId, season, number) via the reverse index', () => {
    s.putEpisodes([{ titleId: 'T1', season: 1, number: 3, episodeId: 'E3', abs: 3, title: 'Sales Contest', aired: null, seasonHash: 'h1' }])
    expect(s.episodePosition('E3')).toEqual({ titleId: 'T1', season: 1, number: 3 })
  })

  it('returns null for an unknown episode id', () => {
    expect(s.episodePosition('NOPE')).toBeNull()
  })

  // episode_map's PRIMARY KEY is (title_id, season, number); episode_id is
  // only a non-unique INDEX. The same episode_id legitimately sitting under
  // two rows must not have one picked arbitrarily -- that would silently
  // guess which show the episode belongs to, on a path that feeds a rating
  // write. Decline instead.
  it('declines rather than picking arbitrarily when an episode id is ambiguous across rows', () => {
    s.putEpisodes([
      { titleId: 'T1', season: 1, number: 3, episodeId: 'E-SHARED', abs: 3, title: 'A', aired: null, seasonHash: 'h1' },
      { titleId: 'T2', season: 2, number: 5, episodeId: 'E-SHARED', abs: 5, title: 'B', aired: null, seasonHash: 'h2' },
    ])
    expect(s.episodePosition('E-SHARED')).toBeNull()
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
      accountId: 'usr_1',
    }
    s.putAuthState(auth)
    const result = s.getAuthState()
    expect(result).toEqual(auth)
  })

  it('returns null on auth state miss', () => {
    expect(s.getAuthState()).toBeNull()
  })

  // SCHEMA uses CREATE TABLE IF NOT EXISTS, so account_id never appears on a
  // database that already exists -- and every upgraded install has one, with a
  // live session in it. Opening it must migrate in place, not throw and not
  // drop the cookie the container is running on.
  it('adds account_id to an auth_state table written by the previous release', () => {
    const dir = mkdtempSync(join(tmpdir(), 'bingers-migrate-'))
    const path = join(dir, 'old.db')
    try {
      const old = new Database(path)
      old.exec(`CREATE TABLE auth_state (id INTEGER PRIMARY KEY CHECK (id = 1), cookie TEXT NOT NULL,
        expires_at TEXT, rotated_at TEXT, checked_at TEXT);`)
      old.prepare('INSERT INTO auth_state (id, cookie, expires_at) VALUES (1,?,?)')
        .run('LIVE', '2027-01-01T00:00:00Z')
      old.close()

      const migrated = openStore(path)
      expect(migrated.getAuthState()).toEqual({
        cookie: 'LIVE', expiresAt: '2027-01-01T00:00:00Z',
        rotatedAt: null, checkedAt: null, accountId: null,
      })
      // and the new column is writable, not just readable
      migrated.putAuthState({
        cookie: 'LIVE', expiresAt: '2027-01-01T00:00:00Z',
        rotatedAt: null, checkedAt: null, accountId: 'u1',
      })
      expect(migrated.getAuthState()!.accountId).toBe('u1')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('upserts rather than throwing on a repeated auth state (singleton check)', () => {
    const auth1 = {
      cookie: 'old_session',
      expiresAt: null,
      rotatedAt: null,
      checkedAt: null,
      accountId: null,
    }
    const auth2 = {
      cookie: 'new_session',
      expiresAt: '2026-09-30T00:00:00Z',
      rotatedAt: '2026-09-16T00:00:00Z',
      checkedAt: '2026-09-16T12:00:00Z',
      accountId: 'usr_1',
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

describe('plex_link', () => {
  it('round-trips a link and returns null on a miss', () => {
    expect(s.getPlexLink('T1')).toBeNull()
    s.putPlexLink({ titleId: 'T1', ratingKey: 'abc123', state: 'added', attempts: 0, nextTryAt: null })
    const l = s.getPlexLink('T1')!
    expect(l.ratingKey).toBe('abc123')
    expect(l.state).toBe('added')
    expect(l.checkedAt).toBeTruthy()
  })

  it('upserts rather than throwing on a repeated link', () => {
    s.putPlexLink({ titleId: 'T1', ratingKey: null, state: 'unresolved', attempts: 1, nextTryAt: '2030-01-01T00:00:00.000Z' })
    s.putPlexLink({ titleId: 'T1', ratingKey: 'k', state: 'added', attempts: 0, nextTryAt: null })
    expect(s.getPlexLink('T1')!.state).toBe('added')
  })

  // Every writer of a deleted follows row -- sync/pull and the outbox mirror --
  // goes through putSyncRows, so the link is dropped here rather than at each
  // call site. A surviving state='added' link makes a re-followed title
  // invisible to dueUnlinkedTitles forever while /health still counts it.
  it('drops the link when the follow is marked deleted, and keeps it otherwise', () => {
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null } }])
    s.putPlexLink({ titleId: 'T1', ratingKey: 'k', state: 'added', attempts: 0, nextTryAt: null })

    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null } }])
    expect(s.getPlexLink('T1')).not.toBeNull() // an ordinary refresh must not unlink

    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', deletedAt: '2026-09-16T12:00:00.000Z' } }])
    expect(s.getPlexLink('T1')).toBeNull()
    expect(s.countPlexLinks('added')).toBe(0) // /health stops counting it too
  })

  it('does not unlink on a deleted row in another table that happens to share a pk', () => {
    s.putPlexLink({ titleId: 'T1', ratingKey: 'k', state: 'added', attempts: 0, nextTryAt: null })
    s.putSyncRows('entries', [{ pk: 'T1', row: { entityId: 'T1', deletedAt: '2026-09-16T12:00:00.000Z' } }])
    expect(s.getPlexLink('T1')).not.toBeNull()
  })
})

describe('dueUnlinkedTitles', () => {
  const NOW = '2026-09-16T12:00:00.000Z'

  it('returns followed titles with no link', () => {
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null } }])
    expect(s.dueUnlinkedTitles(NOW, 10)).toEqual(['T1'])
  })

  it('excludes a title that is already linked', () => {
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null } }])
    s.putPlexLink({ titleId: 'T1', ratingKey: 'k', state: 'added', attempts: 0, nextTryAt: null })
    expect(s.dueUnlinkedTitles(NOW, 10)).toEqual([])
  })

  it('excludes an unfollowed (deleted) title', () => {
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: '2026-09-01T00:00:00.000Z' } }])
    expect(s.dueUnlinkedTitles(NOW, 10)).toEqual([])
  })

  it('excludes an unresolved title until its backoff has elapsed, then returns it', () => {
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null } }])
    s.putPlexLink({ titleId: 'T1', ratingKey: null, state: 'unresolved', attempts: 1, nextTryAt: '2026-09-16T13:00:00.000Z' })
    expect(s.dueUnlinkedTitles(NOW, 10)).toEqual([])
    expect(s.dueUnlinkedTitles('2026-09-16T14:00:00.000Z', 10)).toEqual(['T1'])
  })

  it('excludes a DEFERRED title until its short retry has elapsed, then returns it', () => {
    s.putSyncRows('follows', [{ pk: 'T1', row: { titleId: 'T1', kind: 'show', deletedAt: null } }])
    s.putPlexLink({ titleId: 'T1', ratingKey: null, state: 'deferred', attempts: 1, nextTryAt: '2026-09-16T12:05:00.000Z' })
    expect(s.dueUnlinkedTitles(NOW, 10)).toEqual([])
    expect(s.dueUnlinkedTitles('2026-09-16T12:06:00.000Z', 10)).toEqual(['T1'])
  })

  it('honours the limit', () => {
    s.putSyncRows('follows', [
      { pk: 'A', row: { titleId: 'A', kind: 'show', deletedAt: null } },
      { pk: 'B', row: { titleId: 'B', kind: 'show', deletedAt: null } },
      { pk: 'C', row: { titleId: 'C', kind: 'show', deletedAt: null } },
    ])
    expect(s.dueUnlinkedTitles(NOW, 2)).toHaveLength(2)
  })
})

describe('externalIdsFor', () => {
  it('collects every cached external id for a title, with its name and year', () => {
    s.putTitleMapping([
      { source: 'tmdb', extId: '5920', kind: 'show', titleId: 'M1', title: 'The Mentalist', year: 2008 },
      { source: 'tvdb', extId: '82459', kind: 'show', titleId: 'M1', title: 'The Mentalist', year: 2008 },
    ])
    const r = s.externalIdsFor('M1')
    expect(r.ids).toEqual({ tmdb: '5920', tvdb: '82459' })
    expect(r.title).toBe('The Mentalist')
    expect(r.year).toBe(2008)
  })

  it('returns empty for a title that was never resolved outward', () => {
    expect(s.externalIdsFor('NOPE')).toEqual({ ids: {}, title: null, year: null })
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

describe('rating_link', () => {
  it('round-trips a rating with its origin and returns null on a miss', () => {
    expect(s.getRatingLink('episode', 'E1')).toBeNull()
    s.putRatingLink({ entityKind: 'episode', entityId: 'E1', bingersRating: 5, plexRating: 9, plexRatingKey: '90366', origin: 'plex' })
    const l = s.getRatingLink('episode', 'E1')!
    expect(l.bingersRating).toBe(5)
    expect(l.plexRating).toBe(9)
    expect(l.origin).toBe('plex')
    expect(l.plexRatingKey).toBe('90366')
    expect(l.updatedAt).toBeTruthy()
  })

  it('upserts rather than throwing, and can flip the origin', () => {
    s.putRatingLink({ entityKind: 'episode', entityId: 'E1', bingersRating: 5, plexRating: 9, plexRatingKey: '1', origin: 'plex' })
    s.putRatingLink({ entityKind: 'episode', entityId: 'E1', bingersRating: 3, plexRating: 6, plexRatingKey: '1', origin: 'bingers' })
    expect(s.getRatingLink('episode', 'E1')!.origin).toBe('bingers')
    expect(s.getRatingLink('episode', 'E1')!.bingersRating).toBe(3)
  })

  it('keeps episode and movie namespaces separate', () => {
    s.putRatingLink({ entityKind: 'episode', entityId: 'X', bingersRating: 1, plexRating: 2, plexRatingKey: null, origin: 'plex' })
    expect(s.getRatingLink('movie', 'X')).toBeNull()
  })
})

describe('unratable', () => {
  it('records a plex item as permanently unsupported, once', () => {
    expect(s.isUnratable('86710')).toBe(false)
    s.markUnratable('86710', 'show ratings have no bingers equivalent')
    expect(s.isUnratable('86710')).toBe(true)
  })

  it('is idempotent — marking twice does not throw', () => {
    s.markUnratable('1', 'a')
    s.markUnratable('1', 'a')
    expect(s.isUnratable('1')).toBe(true)
  })
})

describe('ratedEntries', () => {
  it('returns rated movie and episode rows, with titleId only for movies', () => {
    s.putSyncRows('entries', [
      { pk: 'movie:M1', row: { entityKind: 'movie', entityId: 'M1', rating: 4, watched: true, deletedAt: null } },
      { pk: 'episode:E1', row: { entityKind: 'episode', entityId: 'E1', rating: 3, watched: true, deletedAt: null } },
    ])
    const rows = s.ratedEntries()
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.entityKind === 'movie')).toEqual({ entityKind: 'movie', entityId: 'M1', rating: 4, titleId: 'M1' })
    expect(rows.find(r => r.entityKind === 'episode')).toEqual({ entityKind: 'episode', entityId: 'E1', rating: 3, titleId: null })
  })

  it('excludes a deleted row and a row with no rating', () => {
    s.putSyncRows('entries', [
      { pk: 'movie:M1', row: { entityKind: 'movie', entityId: 'M1', rating: 4, deletedAt: '2026-01-01T00:00:00.000Z' } },
      { pk: 'movie:M2', row: { entityKind: 'movie', entityId: 'M2', deletedAt: null } },
    ])
    expect(s.ratedEntries()).toEqual([])
  })

  it('excludes a rating outside the 1-5 range', () => {
    s.putSyncRows('entries', [
      { pk: 'movie:M1', row: { entityKind: 'movie', entityId: 'M1', rating: 0, deletedAt: null } },
      { pk: 'movie:M2', row: { entityKind: 'movie', entityId: 'M2', rating: 6, deletedAt: null } },
    ])
    expect(s.ratedEntries()).toEqual([])
  })

  it('F8: skips a row whose entityKind is not one of the two legal values, rather than trusting the cast', () => {
    s.putSyncRows('entries', [
      { pk: 'show:S1', row: { entityKind: 'show', entityId: 'S1', rating: 4, deletedAt: null } },
      { pk: 'movie:M1', row: { entityKind: 'movie', entityId: 'M1', rating: 4, deletedAt: null } },
    ])
    const rows = s.ratedEntries()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.entityKind).toBe('movie')
  })
})
