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
    expect(c.dbPath).toBe('/data/bingers-sync.db')
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
