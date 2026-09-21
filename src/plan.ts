// The fields a follows op asserts. Deliberately does NOT include
// watchlistHidden: follows ops MERGE server-side, so a field we omit is a field
// left alone, and the app treats hiding as an axis of its own -- it is never
// written alongside these two. Asserting it false here would silently un-hide
// every show a scrobble touches.
export type FollowFields = { kind: string; forLater: boolean; stopped: boolean }

/**
 * The parked states of a show we already follow, as booleans.
 *
 * Bingers is asymmetric here: a push asserts `forLater`/`stopped` as booleans,
 * while a pull reports them as the nullable timestamps `forLaterAt` /
 * `stoppedWatchingAt`. This type is the boolean side of that line -- see
 * followState() in handlers.ts, which is the one place the conversion happens.
 */
export type FollowState = { forLater: boolean; stopped: boolean }

/**
 * What Bingers already records for one episode or movie.
 *
 * Unlike follows, entries need no vocabulary translation: a pulled row reports
 * `watched` and `plays` under exactly those names, so this is the shape the
 * mirror already holds. (firstWatchedAt/lastWatchedAt are the server's business
 * -- it derives both from `plays` on its own.)
 */
export type EntryState = { watched: boolean; plays: number }
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
  // What PLEX reported, which is not necessarily what we write: see playsFor.
  plexPlays: number
  watchedAt: string
  // null when the show is not followed at all (or the follow was deleted).
  follow: FollowState | null
  // What bingers already has for the scrobbled entity; null when it has nothing.
  entry: EntryState | null
  backfill: { episodeId: string; plays: number; watchedAt: string }[]
  newId: () => string
}

/**
 * The play count to write, which is monotonic by construction.
 *
 * A rewatch on Bingers IS just a higher `plays`: the server keeps
 * firstWatchedAt, moves lastWatchedAt and counts the rewatch itself, so there is
 * no flag to set and this number is the entire feature.
 *
 * Plex alone cannot be trusted with it. It reports 1 for a rebuilt library and
 * omits viewCount altogether often enough that parse.ts defaults it to 1, so
 * taking it literally wrote plays:1 over a count of 3 and destroyed the
 * rewatch history. The floor fixes that: never below what Bingers already has,
 * and one above it when Bingers already calls this watched.
 *
 * Consequence accepted deliberately: a scrobble Plex delivers twice counts
 * twice. Plex only fires media.scrobble on genuine playback completion, and
 * /plex always answers 200 so Plex never retries -- and a count one too high is
 * a far smaller loss than a rewatch history erased.
 */
function playsFor(plexPlays: number, entry: EntryState | null): number {
  const stored = entry?.plays ?? 0
  const floor = entry?.watched ? stored + 1 : stored
  return Math.max(plexPlays, floor, 1)
}

function followOp(newId: () => string, titleId: string, kind: string): Op {
  return { opId: newId(), table: 'follows', pk: { titleId }, fields: { kind, forLater: false, stopped: false } }
}

export function planScrobble(input: ScrobbleInput): Plan {
  const ops: Op[] = []
  const dated: DatedWrite[] = []

  // Three reasons to write the follow row, one condition: it is not in the
  // state a watch implies. Not followed at all is the obvious one. The other
  // two are shows we DO follow but have parked -- in Watch Later, or stopped --
  // where the old "is it followed?" test said "nothing to do" and left the show
  // parked while marking its episode watched. Watching an episode settles both.
  if (!input.follow || input.follow.forLater || input.follow.stopped) {
    ops.push(followOp(input.newId, input.titleId, input.kind))
  }

  const batchId = input.backfill.length > 0 ? input.newId() : null

  ops.push({
    opId: input.newId(), table: 'entries',
    pk: { entityKind: input.entityKind, entityId: input.entityId },
    fields: { watched: true, plays: playsFor(input.plexPlays, input.entry), batchId },
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
