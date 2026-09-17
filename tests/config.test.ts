import { describe, it, expect } from 'vitest'
import { loadConfig } from '../src/config.js'

const base = {
  BINGERS_SESSION_COOKIE: 'tok',
  PLEX_URL: 'http://plex.local:32400',
  PLEX_TOKEN: 'plex',
  ALLOWED_USER: 'testuser',
}

describe('loadConfig', () => {
  it('applies documented defaults', () => {
    const c = loadConfig(base as NodeJS.ProcessEnv)
    expect(c.dryRun).toBe(true)
    expect(c.port).toBe(8787)
    expect(c.catalogTtlHours).toBe(24)
    expect(c.searchMaxPages).toBe(3)
    expect(c.watchDateToleranceSec).toBe(120)
    expect(c.syncPullIntervalMin).toBe(30)
    expect(c.plexAllLeavesTtlMin).toBe(60)
    // A confirmed rating no-match is re-checked after a week: bingers'
    // catalogue keeps gaining entries, so "not in the catalogue" is never a
    // permanent property of the item.
    expect(c.unratableRecheckHours).toBe(168)
    expect(c.dbPath).toBe('/data/bingers-sync.db')
    expect(c.reverseBatch).toBe(10)
    expect(c.notifyUrl).toBeNull()
    expect(c.bingersUserAgent).toBe('Bingers/55 CFNetwork/3896.100.1.2.1 Darwin/27.0.0')
  })

  it('strips trailing slashes from PLEX_URL', () => {
    expect(loadConfig({ ...base, PLEX_URL: 'http://plex.local:32400/' } as NodeJS.ProcessEnv).plexUrl).toBe(
      'http://plex.local:32400',
    )
    expect(loadConfig({ ...base, PLEX_URL: 'http://plex.local:32400///' } as NodeJS.ProcessEnv).plexUrl).toBe(
      'http://plex.local:32400',
    )
  })

  it('only disables dry run for the exact string "false"', () => {
    expect(loadConfig({ ...base, DRY_RUN: 'false' } as NodeJS.ProcessEnv).dryRun).toBe(false)
    expect(loadConfig({ ...base, DRY_RUN: '0' } as NodeJS.ProcessEnv).dryRun).toBe(true)
    expect(loadConfig({ ...base, DRY_RUN: 'FALSE' } as NodeJS.ProcessEnv).dryRun).toBe(true)
  })

  // The first reverse-sync run adds EVERY unlinked follow to the real Plex
  // watchlist, and production already runs DRY_RUN=false — so a pull-and-
  // restart must not start doing that. Unset is off, and only the exact string
  // enables it, so a typo fails towards "off" rather than towards a download
  // request per title in the follow history.
  it('leaves reverse sync OFF unless REVERSE_SYNC is exactly "true"', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).reverseSync).toBe(false)
    expect(loadConfig({ ...base, REVERSE_SYNC: 'true' } as NodeJS.ProcessEnv).reverseSync).toBe(true)
    for (const typo of ['True', 'TRUE', '1', 'yes', 'on', '', 'false']) {
      expect(loadConfig({ ...base, REVERSE_SYNC: typo } as NodeJS.ProcessEnv).reverseSync).toBe(false)
    }
  })

  // Same reasoning as REVERSE_SYNC, and the same failure direction: rating
  // sync writes to two live accounts and its first run touches every
  // already-rated item in the library. A typo must leave it OFF.
  it('leaves rating sync OFF unless RATING_SYNC is exactly "true"', () => {
    expect(loadConfig(base as NodeJS.ProcessEnv).ratingSync).toBe(false)
    expect(loadConfig({ ...base, RATING_SYNC: 'true' } as NodeJS.ProcessEnv).ratingSync).toBe(true)
    for (const typo of ['True', 'TRUE', '1', 'yes', 'on', '', 'false']) {
      expect(loadConfig({ ...base, RATING_SYNC: typo } as NodeJS.ProcessEnv).ratingSync).toBe(false)
    }
  })

  it('requires ALLOWED_USER — no identity is baked into the code', () => {
    const { ALLOWED_USER, ...without } = base as Record<string, string>
    expect(() => loadConfig(without as NodeJS.ProcessEnv)).toThrow()
    expect(loadConfig(base as NodeJS.ProcessEnv).allowedUser).toBe('testuser')
  })

  it('throws when a required secret is missing', () => {
    expect(() => loadConfig({ PLEX_URL: 'x', PLEX_TOKEN: 'y' } as NodeJS.ProcessEnv)).toThrow()
  })

  // The cookie is no longer a boot-time requirement: a fresh container comes up
  // with none and sends you to /setup to get one. Requiring it here would make
  // the unconfigured container refuse to start and never serve that page.
  it('boots without BINGERS_SESSION_COOKIE', () => {
    const { BINGERS_SESSION_COOKIE, ...without } = base as Record<string, string>
    expect(loadConfig(without as NodeJS.ProcessEnv).bingersCookie).toBe('')
  })
})
