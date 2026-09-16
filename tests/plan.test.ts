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
