// Plex userRating is 0-10 with half-star granularity (9 = 4.5 stars).
// Bingers rating is an integer 1-5. The conversion down is therefore lossy for
// every odd Plex value, which on a real library is most of them.

export function plexToBingers(userRating: number): number | null {
  if (!Number.isFinite(userRating) || userRating <= 0 || userRating > 10) return null
  return Math.min(5, Math.max(1, Math.round(userRating / 2)))
}

export function bingersToPlex(rating: number): number {
  return Math.min(10, Math.max(2, Math.round(rating) * 2))
}
