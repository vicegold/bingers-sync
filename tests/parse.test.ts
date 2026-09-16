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
