import type { Store, AuthState } from '../store.js'

const COOKIE_NAME = '__Secure-better-auth.session_token'
const API = 'https://api.bingers.app'

/**
 * Everything needed to put the session back exactly as it was. /setup takes one
 * before it redeems a link, so a link that turns out not to work -- or to belong
 * to someone else -- leaves the container on the session it already had rather
 * than on a half-adopted one.
 */
export type AuthSnapshot = { state: AuthState; unauthorized: boolean }

export function createAuth(store: Store, initialCookie: string, userAgent: string) {
  // `||`, not `??`: a persisted EMPTY cookie is not a session, and must not
  // shadow a seed from the environment. A persisted real one still wins --
  // the database is the source of truth once /setup has run.
  let cookie = store.getAuthState()?.cookie || initialCookie

  // Set when an authenticated call comes back 401, i.e. the cookie we hold is
  // no longer a session. In memory only, which is enough: a restart clears it,
  // but the boot heartbeat re-establishes it on the next 401, and plain expiry
  // is covered by the persisted expiresAt instead.
  let unauthorized = false

  function persist(patch: Partial<AuthState>) {
    const prev = store.getAuthState()
    store.putAuthState({
      cookie,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : prev?.expiresAt ?? null,
      rotatedAt: patch.rotatedAt !== undefined ? patch.rotatedAt : prev?.rotatedAt ?? null,
      checkedAt: patch.checkedAt !== undefined ? patch.checkedAt : prev?.checkedAt ?? null,
      accountId: patch.accountId !== undefined ? patch.accountId : prev?.accountId ?? null,
    })
  }

  return {
    cookieHeader() { return `${COOKIE_NAME}=${cookie}` },

    hasSession() { return cookie !== '' },

    /**
     * Take the session cookie out of a response, if it carried one, and report
     * whether it did. The boolean is the only honest answer to "did THIS
     * response authenticate us" -- hasSession() answers the different question
     * of whether we hold a cookie at all, which is still true when the one we
     * hold is dead.
     */
    absorb(res: Response): boolean {
      const raw = (res.headers as any).getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean)
      let carried = false
      for (const line of raw as string[]) {
        const m = new RegExp(`${COOKIE_NAME.replace(/\./g, '\\.')}=([^;]+)`).exec(line)
        if (!m?.[1]) continue
        carried = true
        if (m[1] !== cookie) {
          cookie = m[1]
          // A new cookie is a new session; whatever 401'd was the old one.
          unauthorized = false
          persist({ rotatedAt: new Date().toISOString() })
        }
      }
      return carried
    },

    // Called by every authenticated call that sees a 401. Recorded here rather
    // than only on the write gate because a 401 on a READ (pull, heartbeat)
    // never halts writes, yet means the session is just as dead.
    noteUnauthorized() { unauthorized = true },

    /**
     * Do we hold a cookie that is known not to work? Distinct from
     * !hasSession(), which is "we hold nothing". Both reopen /setup, and this
     * one is the case the gate alone never caught: a session that simply ran
     * out, with no pending write to 401 and halt on.
     */
    sessionDead(): boolean {
      if (cookie === '') return false
      if (unauthorized) return true
      const e = store.getAuthState()?.expiresAt
      if (!e) return false
      const t = Date.parse(e)
      return Number.isFinite(t) && t <= Date.now()
    },

    // The Bingers account the stored session belongs to, once a heartbeat has
    // seen it. /setup binds to the first one it learns.
    accountId(): string | null { return store.getAuthState()?.accountId ?? null },

    snapshot(): AuthSnapshot {
      const s = store.getAuthState()
      return {
        state: {
          cookie,
          expiresAt: s?.expiresAt ?? null,
          rotatedAt: s?.rotatedAt ?? null,
          checkedAt: s?.checkedAt ?? null,
          accountId: s?.accountId ?? null,
        },
        unauthorized,
      }
    },

    restore(snap: AuthSnapshot) {
      cookie = snap.state.cookie
      unauthorized = snap.unauthorized
      store.putAuthState(snap.state)
    },

    async heartbeat(fetchImpl: typeof fetch = fetch) {
      const before = store.getAuthState()?.cookie
      const res = await fetchImpl(`${API}/auth/get-session?disableCookieCache=true`, {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}`, 'User-Agent': userAgent, Accept: 'application/json' },
      })
      this.absorb(res)
      // After absorb: if the response rotated us onto a new cookie, that new
      // one has not failed at anything and absorb has already cleared the flag.
      if (res.status === 401) unauthorized = true
      if (!res.ok) throw new Error(`heartbeat -> ${res.status}`)
      const body = (await res.json()) as { session?: { expiresAt?: string }; user?: { id?: string } } | null
      const expiresAt = body?.session?.expiresAt ?? null
      const accountId = body?.user?.id ?? null
      unauthorized = false
      persist({
        expiresAt, checkedAt: new Date().toISOString(),
        // Only ever write an id we actually saw; a response without `user`
        // must not erase the account this container is bound to.
        ...(accountId ? { accountId } : {}),
      })
      return { expiresAt, accountId, rotated: store.getAuthState()?.cookie !== before }
    },

    daysRemaining(): number | null {
      const e = store.getAuthState()?.expiresAt
      if (!e) return null
      return Math.floor((Date.parse(e) - Date.now()) / 86_400_000)
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
