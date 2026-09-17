import { describe, it, expect } from 'vitest'
import { plexToBingers, bingersToPlex } from '../src/ratings/scale.js'

describe('plexToBingers', () => {
  it('maps whole-star values exactly', () => {
    expect(plexToBingers(2)).toBe(1)
    expect(plexToBingers(4)).toBe(2)
    expect(plexToBingers(6)).toBe(3)
    expect(plexToBingers(8)).toBe(4)
    expect(plexToBingers(10)).toBe(5)
  })

  it('rounds half-stars to the nearest whole star', () => {
    expect(plexToBingers(9)).toBe(5)   // 4.5 -> 5
    expect(plexToBingers(7)).toBe(4)   // 3.5 -> 4
    expect(plexToBingers(3)).toBe(2)   // 1.5 -> 2
    expect(plexToBingers(1)).toBe(1)   // 0.5 -> 1, never 0
  })

  it('never produces a value outside 1..5', () => {
    for (let v = 0; v <= 10; v += 0.5) {
      const r = plexToBingers(v)
      if (r !== null) { expect(r).toBeGreaterThanOrEqual(1); expect(r).toBeLessThanOrEqual(5) }
    }
  })

  it('returns null for an absent or nonsense rating rather than inventing one', () => {
    expect(plexToBingers(0)).toBeNull()
    expect(plexToBingers(-1)).toBeNull()
    expect(plexToBingers(NaN)).toBeNull()
    expect(plexToBingers(11)).toBeNull()
  })
})

describe('bingersToPlex', () => {
  it('maps 1..5 onto whole stars', () => {
    expect(bingersToPlex(1)).toBe(2)
    expect(bingersToPlex(3)).toBe(6)
    expect(bingersToPlex(5)).toBe(10)
  })
})

// The round-trip property src/ratings/toPlex.ts's Layer 2 live-value guard
// depends on entirely: an EVEN plex value survives plexToBingers ->
// bingersToPlex exactly (a true no-op, safe to skip silently); an ODD plex
// value (a half-star) always lands one step HIGHER than where it started
// (the guard must therefore treat it as an active, loggable refusal, not a
// silent skip). Pinned directly -- this needs no `isLossy` helper to exist.
describe('plexToBingers -> bingersToPlex round trip', () => {
  it('is exact for every even plex value, and lands on exactly v+1 for every odd one', () => {
    for (let v = 1; v <= 10; v++) {
      const bingers = plexToBingers(v)!
      const back = bingersToPlex(bingers)
      if (v % 2 === 0) expect(back).toBe(v)
      else expect(back).toBe(v + 1)
    }
  })
})
