export type FollowFields = { kind: string; forLater: boolean; stopped: boolean; watchlistHidden: boolean }
export type Op =
  | { opId: string; table: 'follows'; pk: { titleId: string }; fields: FollowFields }
  | { opId: string; table: 'follows'; pk: { titleId: string }; deleted: true }
  | { opId: string; table: 'entries'; pk: { entityKind: 'episode' | 'movie'; entityId: string }; fields: { watched: true; plays: number; batchId: string | null } }
  | { opId: string; table: 'entries'; pk: { entityKind: 'episode' | 'movie'; entityId: string }; fields: { rating: number } }

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
