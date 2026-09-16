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
