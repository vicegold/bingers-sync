import type { Store } from '../store.js'

const COOKIE_NAME = '__Secure-better-auth.session_token'
const API = 'https://api.bingers.app'

export function createAuth(store: Store, initialCookie: string, userAgent: string) {
  let cookie = store.getAuthState()?.cookie ?? initialCookie

  function persist(patch: Partial<{ expiresAt: string | null; rotatedAt: string | null; checkedAt: string | null }>) {
    const prev = store.getAuthState()
    store.putAuthState({
      cookie,
      expiresAt: patch.expiresAt !== undefined ? patch.expiresAt : prev?.expiresAt ?? null,
      rotatedAt: patch.rotatedAt !== undefined ? patch.rotatedAt : prev?.rotatedAt ?? null,
      checkedAt: patch.checkedAt !== undefined ? patch.checkedAt : prev?.checkedAt ?? null,
    })
  }

  return {
    cookieHeader() { return `${COOKIE_NAME}=${cookie}` },

    hasSession() { return cookie !== '' },

    absorb(res: Response) {
      const raw = (res.headers as any).getSetCookie?.() ?? [res.headers.get('set-cookie')].filter(Boolean)
      for (const line of raw as string[]) {
        const m = new RegExp(`${COOKIE_NAME.replace(/\./g, '\\.')}=([^;]+)`).exec(line)
        if (m?.[1] && m[1] !== cookie) {
          cookie = m[1]
          persist({ rotatedAt: new Date().toISOString() })
        }
      }
    },

    async heartbeat(fetchImpl: typeof fetch = fetch) {
      const before = store.getAuthState()?.cookie
      const res = await fetchImpl(`${API}/auth/get-session?disableCookieCache=true`, {
        headers: { Cookie: `${COOKIE_NAME}=${cookie}`, 'User-Agent': userAgent, Accept: 'application/json' },
      })
      this.absorb(res)
      if (!res.ok) throw new Error(`heartbeat -> ${res.status}`)
      const body = (await res.json()) as { session?: { expiresAt?: string } } | null
      const expiresAt = body?.session?.expiresAt ?? null
      persist({ expiresAt, checkedAt: new Date().toISOString() })
      return { expiresAt, rotated: store.getAuthState()?.cookie !== before }
    },

    daysRemaining(): number | null {
      const e = store.getAuthState()?.expiresAt
      if (!e) return null
      return Math.floor((Date.parse(e) - Date.now()) / 86_400_000)
    },
  }
}

export type Auth = ReturnType<typeof createAuth>
