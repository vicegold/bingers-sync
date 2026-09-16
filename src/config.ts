import { z } from 'zod'

const Schema = z.object({
  // Optional, unlike every other secret: an unconfigured container has to boot
  // far enough to serve /setup, which is where the cookie now comes from.
  BINGERS_SESSION_COOKIE: z.string().default(''),
  BINGERS_USER_AGENT: z.string().default('Bingers/55 CFNetwork/3896.100.1.2.1 Darwin/27.0.0'),
  PLEX_URL: z.string().min(1),
  PLEX_TOKEN: z.string().min(1),
  ALLOWED_USER: z.string().min(1),
  DRY_RUN: z.string().default('true'),
  PORT: z.coerce.number().default(8787),
  DB_PATH: z.string().default('/data/bingers-sync.db'),
  CATALOG_TTL_HOURS: z.coerce.number().default(24),
  SEARCH_MAX_PAGES: z.coerce.number().default(3),
  SYNC_PULL_INTERVAL_MIN: z.coerce.number().default(30),
  WATCH_DATE_TOLERANCE_SEC: z.coerce.number().default(120),
  PLEX_ALLLEAVES_TTL_MIN: z.coerce.number().default(60),
  NOTIFY_URL: z.string().optional(),
})

export type Config = ReturnType<typeof loadConfig>

export function loadConfig(env: NodeJS.ProcessEnv) {
  const e = Schema.parse(env)
  return {
    bingersCookie: e.BINGERS_SESSION_COOKIE,
    bingersUserAgent: e.BINGERS_USER_AGENT,
    plexUrl: e.PLEX_URL.replace(/\/+$/, ''),
    plexToken: e.PLEX_TOKEN,
    allowedUser: e.ALLOWED_USER,
    dryRun: e.DRY_RUN !== 'false',
    port: e.PORT,
    dbPath: e.DB_PATH,
    catalogTtlHours: e.CATALOG_TTL_HOURS,
    searchMaxPages: e.SEARCH_MAX_PAGES,
    syncPullIntervalMin: e.SYNC_PULL_INTERVAL_MIN,
    watchDateToleranceSec: e.WATCH_DATE_TOLERANCE_SEC,
    plexAllLeavesTtlMin: e.PLEX_ALLLEAVES_TTL_MIN,
    notifyUrl: e.NOTIFY_URL ?? null,
  }
}
