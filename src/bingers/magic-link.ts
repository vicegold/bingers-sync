// What the user pastes into /setup is whatever their mail client let them copy:
// the https://bingers.app/m?token=... link, the bingers:///magic-link?token=...
// deep link the web page redirects to, or -- if they dug it out themselves --
// the bare token. All three carry the same value, which is what
// /auth/magic-link/verify wants.
import type { Auth } from './auth.js'

const API = 'https://api.bingers.app'
const BARE_TOKEN = /^[A-Za-z0-9_-]{16,}$/

export type RedeemDeps = { auth: Auth; userAgent: string; fetchImpl?: typeof fetch }
export type RedeemResult = { ok: true } | { ok: false; reason: string }

export function parseMagicLinkToken(input: string): string | null {
  const s = input.trim()
  const m = /[?&]token=([^&#\s]+)/.exec(s)
  if (m?.[1]) return m[1]
  // Length-gated so a mis-paste ("hello") is rejected here rather than spending
  // a single-use verify request to find out.
  return BARE_TOKEN.test(s) ? s : null
}

// Trades a single-use magic link token for a session cookie.
//
// This is the same call the app makes when it receives bingers:///magic-link.
// Unlike sign-in/magic-link (which sends the mail) it carries no Turnstile
// header -- the bot check guards the SENDING of a link, not its redemption,
// which is what makes this reachable from a container at all.
export async function redeemMagicLink(deps: RedeemDeps, token: string): Promise<RedeemResult> {
  const f = deps.fetchImpl ?? fetch
  let res: Response
  try {
    res = await f(`${API}/auth/magic-link/verify?token=${encodeURIComponent(token)}`, {
      // The success case is a 302 to the app's bingers:// callbackURL, a scheme
      // fetch cannot follow -- and the Set-Cookie we want rides on that 302.
      redirect: 'manual',
      headers: { 'User-Agent': deps.userAgent, Accept: 'application/json' },
    })
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }

  // absorb() is the single place a cookie enters the system, so a session from
  // /setup persists by exactly the path a rotated one does.
  deps.auth.absorb(res)
  if (!deps.auth.hasSession()) {
    // Success and failure both answer 302; what separates them is the cookie
    // and where the Location points. A rejected token goes to ?error=CODE --
    // INVALID_TOKEN for one that is expired or already spent.
    const code = /[?&]error=([^&#]+)/.exec(res.headers.get('location') ?? '')?.[1]
    return { ok: false, reason: code ?? `no session cookie in the response (HTTP ${res.status})` }
  }
  return { ok: true }
}
