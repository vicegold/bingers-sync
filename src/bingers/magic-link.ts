// What the user pastes into /setup is whatever their mail client let them copy:
// the https://bingers.app/m?token=... link, the bingers:///magic-link?token=...
// deep link the web page redirects to, or -- if they dug it out themselves --
// the bare token. All three carry the same value, which is what
// /auth/magic-link/verify wants.
import type { Auth } from './auth.js'

const API = 'https://api.bingers.app'
const BARE_TOKEN = /^[A-Za-z0-9_-]{16,}$/

// better-auth's rejection codes are SCREAMING_SNAKE. The value arrives in a
// redirect from a remote server and ends up both in a log line and on the page,
// so it is whitelisted rather than escaped: `[^&#]+` admits CR/LF (log forging)
// and quotes, which the page's esc() does not cover.
const ERROR_CODE = /^[A-Z_]{1,64}$/

export type RedeemDeps = { auth: Auth; userAgent: string; fetchImpl?: typeof fetch }
export type RedeemResult = { ok: true } | { ok: false; reason: string }

// Whose ?token= is actually a Bingers magic-link token. A mail provider's
// safe-link wrapper carries a ?token= of its own -- its tracking id -- and
// forwarding that gets INVALID_TOKEN back, which reads to the operator as
// "you tapped the link" when they did not.
function isBingersLink(u: URL): boolean {
  if (u.protocol === 'bingers:') return true
  const h = u.hostname.toLowerCase()
  return h === 'bingers.app' || h.endsWith('.bingers.app')
}

export function parseMagicLinkToken(input: string): string | null {
  // Mail clients autolink a bare URL as <...> and leave the sentence's
  // punctuation attached. Both land inside a naive [^&#\s]+ capture and corrupt
  // the token, which then spends the one-shot link on a guaranteed rejection.
  const s = input.trim().replace(/^[<("']+/, '').replace(/[>)"'.,;]+$/, '')

  try {
    const u = new URL(s)
    if (!isBingersLink(u)) return null
    // searchParams decodes percent-escapes, so the value handed back is the
    // token itself -- not the encoded form, which encodeURIComponent below
    // would otherwise double-encode.
    const t = u.searchParams.get('token')
    return t && BARE_TOKEN.test(t) ? t : null
  } catch { /* not a URL: fall through to the bare-token branch */ }

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
  // /setup persists by exactly the path a rotated one does. Its return value --
  // "did THIS response carry a session cookie" -- is what decides success.
  // auth.hasSession() cannot: re-authenticating means we are still holding the
  // DEAD cookie, so it answers true for a link the server just rejected, and
  // the page would report a green success that leaves the operator locked out.
  if (!deps.auth.absorb(res)) {
    // Success and failure both answer 302; what separates them is the cookie
    // and where the Location points. A rejected token goes to ?error=CODE --
    // INVALID_TOKEN for one that is expired or already spent.
    const raw = /[?&]error=([^&#]+)/.exec(res.headers.get('location') ?? '')?.[1]
    let code: string | null = null
    if (raw) {
      try {
        const decoded = decodeURIComponent(raw)
        if (ERROR_CODE.test(decoded)) code = decoded
      } catch { /* malformed escape: report it as an unnamed rejection */ }
    }
    return { ok: false, reason: code ?? `no session cookie in the response (HTTP ${res.status})` }
  }
  return { ok: true }
}
