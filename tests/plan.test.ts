import { describe, it, expect } from 'vitest'
import { planScrobble, planWatchlist } from '../src/plan.js'

let counter = 0
const newId = () => `id-${++counter}`
const base = {
  titleId: 'T1', kind: 'show' as const, entityKind: 'episode' as const, entityId: 'E3',
  plexPlays: 1, watchedAt: '2026-09-16T10:00:00.000Z',
  // what Bingers already has for this episode; null when it has nothing
  entry: null,
  // null means not followed; the flags are the two mutually exclusive parked
  // states Bingers reports as forLaterAt / stoppedWatchingAt timestamps.
  follow: { forLater: false, stopped: false }, backfill: [], newId,
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
    const p = planScrobble({ ...base, follow: null })
    expect(p.ops).toHaveLength(2)
    expect(p.ops[0]).toMatchObject({
      table: 'follows', pk: { titleId: 'T1' },
      fields: { kind: 'show', forLater: false, stopped: false },
    })
    expect(p.ops[1]!.table).toBe('entries')
  })

  it('never sends timestamps in push fields (not-followed plan)', () => {
    counter = 0
    const p = planScrobble({ ...base, follow: null })
    for (const op of p.ops) {
      const f = JSON.stringify('fields' in op ? op.fields : {})
      expect(f).not.toContain('WatchedAt')
      expect(f).not.toContain('followedAt')
    }
  })

  it('never sends timestamps in push fields (followed plan)', () => {
    counter = 0
    const p = planScrobble(base)
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

  it('orders dated[] as primary entry then backfill entries in input order, for two or more backfill entries', () => {
    counter = 0
    const p = planScrobble({
      ...base,
      backfill: [
        { episodeId: 'E1', plays: 1, watchedAt: '2026-09-02T20:00:00.000Z' },
        { episodeId: 'E2', plays: 3, watchedAt: '2026-09-03T20:00:00.000Z' },
      ],
    })
    expect(p.dated).toEqual([
      { entityKind: 'episode', entityId: 'E3', watchedAt: '2026-09-16T10:00:00.000Z' },
      { entityKind: 'episode', entityId: 'E1', watchedAt: '2026-09-02T20:00:00.000Z' },
      { entityKind: 'episode', entityId: 'E2', watchedAt: '2026-09-03T20:00:00.000Z' },
    ])
  })


  // The reason for this change. A show parked in Watch Later is still followed,
  // so the old `isFollowed` boolean said "nothing to do" and the episode was
  // written while the show stayed parked. Watching an episode means it is not
  // for later any more.
  it('revives a show parked in Watch Later before writing the episode', () => {
    counter = 0
    const p = planScrobble({ ...base, follow: { forLater: true, stopped: false } })
    expect(p.ops).toHaveLength(2)
    expect(p.ops[0]).toMatchObject({
      table: 'follows', pk: { titleId: 'T1' },
      fields: { kind: 'show', forLater: false, stopped: false },
    })
    expect(p.ops[1]!.table).toBe('entries')
  })

  // Same reasoning: scrobbling an episode of a show you stopped means you
  // picked it back up. The app itself writes these two flags together, because
  // they are mutually exclusive states.
  it('revives a show marked stopped', () => {
    counter = 0
    const p = planScrobble({ ...base, follow: { forLater: false, stopped: true } })
    expect(p.ops[0]).toMatchObject({
      table: 'follows', fields: { kind: 'show', forLater: false, stopped: false },
    })
  })

  it('emits one follow op, not two, when both parked states are set', () => {
    counter = 0
    const p = planScrobble({ ...base, follow: { forLater: true, stopped: true } })
    expect(p.ops.filter(o => o.table === 'follows')).toHaveLength(1)
    expect(p.ops).toHaveLength(2)
  })

  // The steady state during a binge: an ordinary followed show needs no follow
  // write at all, and emitting one per episode would be a redundant write.
  it('leaves an ordinary followed show alone', () => {
    counter = 0
    const p = planScrobble(base)
    expect(p.ops.filter(o => o.table === 'follows')).toHaveLength(0)
  })

  // watchlistHidden is an independent axis -- the app only ever writes it on
  // its own. Asserting it false here silently un-hides a show the user hid,
  // because follows ops MERGE: a field we do not send is a field left alone.
  it('never asserts watchlistHidden, so hiding a show survives a scrobble', () => {
    counter = 0
    for (const follow of [null, { forLater: true, stopped: false }]) {
      const p = planScrobble({ ...base, follow })
      const op = p.ops.find(o => o.table === 'follows') as any
      expect(Object.keys(op.fields).sort()).toEqual(['forLater', 'kind', 'stopped'])
    }
  })


  // Rewatches. The server derives the whole rewatch from `plays` alone -- it
  // keeps firstWatchedAt and moves lastWatchedAt itself -- so getting the number
  // right IS the feature. Captured from the app: plays:2 came back as
  // plays:2, firstWatchedAt preserved, lastWatchedAt moved.
  it('counts a second watch of an already-watched episode as a rewatch', () => {
    counter = 0
    const p = planScrobble({ ...base, entry: { watched: true, plays: 1 } })
    const entry = p.ops.find(o => o.table === 'entries') as any
    expect(entry.fields.plays).toBe(2)
  })

  // The bug this closes. Plex is the only source today, and it reports 1 for a
  // rebuilt library or omits viewCount entirely -- which wrote plays:1 over a
  // count of 3 and threw the rewatch history away.
  it('never lets the play count go backwards when plex reports fewer', () => {
    counter = 0
    const p = planScrobble({ ...base, plexPlays: 1, entry: { watched: true, plays: 3 } })
    const entry = p.ops.find(o => o.table === 'entries') as any
    expect(entry.fields.plays).toBe(4)
  })

  it('trusts plex when plex has counted more watches than bingers', () => {
    counter = 0
    const p = planScrobble({ ...base, plexPlays: 5, entry: { watched: true, plays: 1 } })
    const entry = p.ops.find(o => o.table === 'entries') as any
    expect(entry.fields.plays).toBe(5)
  })

  // A row can exist without being watched (bingers writes watched:false,
  // plays:0 when you un-mark something). That is a FIRST watch, not a rewatch.
  it('treats a known-but-unwatched episode as a first watch', () => {
    counter = 0
    const p = planScrobble({ ...base, entry: { watched: false, plays: 0 } })
    const entry = p.ops.find(o => o.table === 'entries') as any
    expect(entry.fields.plays).toBe(1)
  })

  // Pins the `watched` half of the floor, which a plays:0 row cannot: with a
  // count but no watched flag the row contradicts itself, and a scrobble is
  // then a FIRST watch that must not also claim a rewatch on top of the count.
  // Monotonic either way -- the stored count is never lowered.
  it('does not add a rewatch on top of a count the row does not call watched', () => {
    counter = 0
    const p = planScrobble({ ...base, plexPlays: 1, entry: { watched: false, plays: 2 } })
    const entry = p.ops.find(o => o.table === 'entries') as any
    expect(entry.fields.plays).toBe(2)
  })

  it('still writes plays 1 for an episode bingers has never seen', () => {
    counter = 0
    const p = planScrobble({ ...base, entry: null })
    const entry = p.ops.find(o => o.table === 'entries') as any
    expect(entry.fields.plays).toBe(1)
  })

  // Backfilled leaves carry their own plex count and are only ever added for
  // episodes bingers has NOT seen, so the rewatch floor must not touch them.
  it('leaves backfilled leaves on their own plex count', () => {
    counter = 0
    const p = planScrobble({
      ...base, entry: { watched: true, plays: 4 },
      backfill: [{ episodeId: 'E9', plays: 1, watchedAt: '2026-09-01T10:00:00.000Z' }],
    })
    const leaf = p.ops.find(o => o.table === 'entries' && (o as any).pk.entityId === 'E9') as any
    expect(leaf.fields.plays).toBe(1)
  })

  it('handles a movie as entityKind movie with the titleId as entityId', () => {
    counter = 0
    const p = planScrobble({ ...base, kind: 'movie', entityKind: 'movie', entityId: 'T1', follow: null })
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
      fields: { kind: 'show', forLater: false, stopped: false },
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
