import { describe, it, expect, vi, beforeEach } from 'vitest'
import { openStore, type Store } from '../src/store.js'
import { createAuth } from '../src/bingers/auth.js'
import { parseMagicLinkToken, redeemMagicLink } from '../src/bingers/magic-link.js'

const TOKEN = 'JGuDntNbHscqfMOINyLoLIZrrCDVjNzu'
const SET_COOKIE = '__Secure-better-auth.session_token=FRESH; Max-Age=31536000; Path=/; Secure'

let store: Store
beforeEach(() => { store = openStore(':memory:') })

const redeemWith = (res: () => Response) => {
  const auth = createAuth(store, '', 'UA')
  const fetchImpl = vi.fn(async () => res())
  return { auth, fetchImpl, run: () => redeemMagicLink({ auth, userAgent: 'UA', fetchImpl: fetchImpl as any }, TOKEN) }
}

describe('parseMagicLinkToken', () => {
  it('extracts the token from the link the email contains', () => {
    expect(parseMagicLinkToken(`https://bingers.app/m?token=${TOKEN}`)).toBe(TOKEN)
  })

  // The app's own deep link. Someone who taps the email on a desktop sees this
  // in the browser's "open in app?" prompt and may well copy THAT instead.
  it('extracts the token from the bingers:// deep link', () => {
    expect(parseMagicLinkToken(`bingers:///magic-link?token=${TOKEN}`)).toBe(TOKEN)
  })

  it('accepts a bare token pasted on its own', () => {
    expect(parseMagicLinkToken(TOKEN)).toBe(TOKEN)
  })

  // Copying a link out of a mail client picks up leading/trailing whitespace
  // and, in some clients, a trailing newline.
  it('ignores surrounding whitespace', () => {
    expect(parseMagicLinkToken(`  https://bingers.app/m?token=${TOKEN}\n`)).toBe(TOKEN)
    expect(parseMagicLinkToken(`\n${TOKEN}  `)).toBe(TOKEN)
  })

  it('returns null when there is no token to find', () => {
    expect(parseMagicLinkToken('')).toBeNull()
    expect(parseMagicLinkToken('https://bingers.app/m')).toBeNull()
    expect(parseMagicLinkToken('hello world')).toBeNull()
  })

  // Guards the bare-token branch: a short scrap of text is a mis-paste, not a
  // token, and sending it to /magic-link/verify would burn a request to learn
  // what a length check already knows.
  it('rejects a bare string too short to be a token', () => {
    expect(parseMagicLinkToken('abc123')).toBeNull()
  })

  // Mail clients autolink a bare URL as <...> and leave the sentence's
  // punctuation attached. An unanchored [^&#\s]+ capture swallows both, and the
  // corrupted token then spends the one-shot link on a certain rejection.
  it('strips the wrapping a mail client adds around an autolinked url', () => {
    expect(parseMagicLinkToken(`<https://bingers.app/m?token=${TOKEN}>`)).toBe(TOKEN)
    expect(parseMagicLinkToken(`https://bingers.app/m?token=${TOKEN}.`)).toBe(TOKEN)
    expect(parseMagicLinkToken(`"https://bingers.app/m?token=${TOKEN}",`)).toBe(TOKEN)
  })

  // The capture used to go straight to encodeURIComponent, so any escape in the
  // link was encoded a second time and the server saw a different token.
  it('decodes a percent-escaped token instead of re-encoding it', () => {
    expect(parseMagicLinkToken('https://bingers.app/m?token=abcDEF1234567890%2D%2D'))
      .toBe('abcDEF1234567890--')
  })

  // A mail provider that rewrites links carries its own ?token= -- its tracking
  // id. Taking the first token= anywhere in the string sends that instead, and
  // the INVALID_TOKEN that comes back reads as "you tapped the link".
  it('refuses a link rewritten to point at a click tracker', () => {
    expect(parseMagicLinkToken(
      `https://click.example.com/?token=trackingid0123456789&url=https%3A%2F%2Fbingers.app%2Fm%3Ftoken%3D${TOKEN}`,
    )).toBeNull()
  })

  it('accepts the app subdomain but not a lookalike host', () => {
    expect(parseMagicLinkToken(`https://api.bingers.app/m?token=${TOKEN}`)).toBe(TOKEN)
    expect(parseMagicLinkToken(`https://bingers.app.evil.test/m?token=${TOKEN}`)).toBeNull()
  })

  // A value that reaches the URL branch but is not token-shaped must not be
  // forwarded: it is a mis-paste, and sending it burns a request to find out.
  it('rejects a token-shaped parameter that is not token-shaped', () => {
    expect(parseMagicLinkToken('https://bingers.app/m?token=short')).toBeNull()
  })
})

describe('redeemMagicLink', () => {
  it('trades the token for a session cookie at the verify endpoint', async () => {
    const { auth, fetchImpl, run } = redeemWith(() =>
      new Response(null, { status: 302, headers: { 'set-cookie': SET_COOKIE } }))

    expect(await run()).toMatchObject({ ok: true })
    expect(auth.cookieHeader()).toBe('__Secure-better-auth.session_token=FRESH')
    expect(store.getAuthState()!.cookie).toBe('FRESH')
    expect(String(fetchImpl.mock.calls[0][0])).toContain(`/auth/magic-link/verify?token=${TOKEN}`)
  })

  // better-auth answers verify with a 302 to the callbackURL, and the app's
  // callbackURL is bingers:///magic-link -- a scheme fetch cannot follow. Left
  // on the default 'follow' this throws before anyone reads the Set-Cookie the
  // 302 is carrying, which is the only thing we actually came for.
  it('does not follow the redirect that carries the cookie', async () => {
    const { fetchImpl, run } = redeemWith(() =>
      new Response(null, { status: 302, headers: { 'set-cookie': SET_COOKIE } }))
    await run()
    expect((fetchImpl.mock.calls[0][1] as RequestInit).redirect).toBe('manual')
  })

  it('identifies itself as the app, since that is the session being minted', async () => {
    const { fetchImpl, run } = redeemWith(() =>
      new Response(null, { status: 302, headers: { 'set-cookie': SET_COOKIE } }))
    await run()
    const headers = (fetchImpl.mock.calls[0][1] as RequestInit).headers as Record<string, string>
    expect(headers['User-Agent']).toBe('UA')
  })

  // An expired or already-tapped token still answers, just without a cookie.
  // Reporting that as success would leave the container "set up" with no session.
  it('reports failure when the response carries no session cookie', async () => {
    const { auth, run } = redeemWith(() => new Response('{}', { status: 200 }))
    expect(await run()).toMatchObject({ ok: false })
    expect(auth.hasSession()).toBe(false)
  })

  // A spent or expired token gets a 302 like a good one does -- the difference
  // is that it carries no cookie and redirects to ?error=CODE instead of the
  // callbackURL. Verified against the live endpoint: a used token answers
  // 302 -> https://api.bingers.app/?error=INVALID_TOKEN.
  it('surfaces the error code the redirect carries', async () => {
    const { run } = redeemWith(() => new Response(null, {
      status: 302, headers: { location: 'https://api.bingers.app/?error=INVALID_TOKEN' },
    }))
    const r = await run()
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toContain('INVALID_TOKEN')
  })

  it('reports failure when the endpoint rejects the token outright', async () => {
    const { run } = redeemWith(() => new Response('{"error":"INVALID_TOKEN"}', { status: 400 }))
    expect(await run()).toMatchObject({ ok: false })
  })

  // THE re-authentication case, and the one hasSession() cannot answer. The
  // session died, /setup reopened, and the STALE cookie is still loaded. A
  // rejected link sets no cookie, so "do we have a session" is still true --
  // and reporting that as success told the operator it worked, reopened the
  // write gate on a dead cookie, and closed the only page that could fix it.
  it('reports failure on a rejected link even while a dead cookie is still loaded', async () => {
    const auth = createAuth(store, 'STALE', 'UA')
    const fetchImpl = vi.fn(async () => new Response(null, {
      status: 302, headers: { location: 'https://api.bingers.app/?error=INVALID_TOKEN' },
    }))
    const r = await redeemMagicLink({ auth, userAgent: 'UA', fetchImpl: fetchImpl as any }, TOKEN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toContain('INVALID_TOKEN')
    // and the dead cookie is untouched, not silently promoted to "the session"
    expect(auth.cookieHeader()).toBe('__Secure-better-auth.session_token=STALE')
  })

  // The error code is remote input that ends up in a container log line and in
  // the page body. [^&#]+ admits CR/LF and quotes; esc() escapes neither.
  it('does not echo an error code that is not a better-auth error code', async () => {
    const { run } = redeemWith(() => new Response(null, {
      status: 302,
      headers: { location: 'https://api.bingers.app/?error=OK%0d%0a%5bsetup%5d+session+stored' },
    }))
    const r = await run()
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).not.toContain('session stored')
    expect((r as { reason: string }).reason).toContain('no session cookie')
  })

  it('surfaces a network failure instead of throwing at the caller', async () => {
    const auth = createAuth(store, '', 'UA')
    const fetchImpl = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const r = await redeemMagicLink({ auth, userAgent: 'UA', fetchImpl: fetchImpl as any }, TOKEN)
    expect(r).toMatchObject({ ok: false })
    expect((r as { reason: string }).reason).toContain('ECONNREFUSED')
  })
})
