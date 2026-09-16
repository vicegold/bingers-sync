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
