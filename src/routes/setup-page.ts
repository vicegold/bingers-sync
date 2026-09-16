const esc = (s: string) => s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!))

const SHELL = (title: string, body: string) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${title}</title>
<style>
  :root { color-scheme: dark light; --fg:#e8e8ea; --dim:#9a9aa2; --bg:#151518; --card:#1e1e23;
          --line:#32323a; --accent:#7aa2f7; --bad:#f7768e; --good:#9ece6a; }
  * { box-sizing: border-box }
  body { margin:0; padding:32px 16px; background:var(--bg); color:var(--fg);
         font:15px/1.55 ui-sans-serif,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:620px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; letter-spacing:-.01em }
  .sub { color:var(--dim); margin:0 0 24px }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:20px; }
  ol { margin:0 0 20px; padding-left:20px }
  li { margin-bottom:10px }
  code { background:#000; border:1px solid var(--line); border-radius:4px;
         padding:1px 5px; font-size:13px; font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .warn { color:var(--fg); background:#2a2320; border-left:3px solid #e0af68;
          padding:10px 14px; border-radius:0 6px 6px 0; margin:0 0 20px; font-size:14px }
  label { display:block; font-weight:600; margin-bottom:8px; font-size:14px }
  input { width:100%; padding:10px 12px; border-radius:6px; border:1px solid var(--line);
          background:#000; color:var(--fg); font-size:14px;
          font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  input:focus { outline:2px solid var(--accent); outline-offset:-1px; border-color:transparent }
  button { margin-top:14px; width:100%; padding:11px; border-radius:6px; border:0;
           background:var(--accent); color:#0d0d10; font-weight:650; font-size:15px; cursor:pointer }
  button:hover { filter:brightness(1.08) }
  .err { color:var(--bad); border-left:3px solid var(--bad); background:#2a1c20;
         padding:10px 14px; border-radius:0 6px 6px 0; margin:0 0 20px; font-size:14px }
  .ok { color:var(--good); font-size:15px; margin:0 0 8px; font-weight:600 }
  .foot { color:var(--dim); font-size:13px; margin-top:20px; text-align:center }
  a { color:var(--accent) }
</style></head><body><main>${body}</main></body></html>`

/**
 * The setup page. Its whole job is one paste, so the instructions carry more
 * weight than the form: the token is single-use, and TAPPING the link in the
 * email spends it on the phone before it ever reaches here. Saying so up front
 * is the difference between this working first time and looking broken.
 */
export function setupPage(opts: { error?: string; done?: boolean }): string {
  if (opts.done) {
    return SHELL('Connected — bingers-sync', `
      <h1>Connected</h1>
      <p class="sub">bingers-sync has a session and this page has closed itself.</p>
      <div class="card">
        <p class="ok">✓ Session stored</p>
        <p style="margin:0;color:var(--dim)">It survives restarts — it lives in the database under
        <code>/data</code>, not in <code>.env</code>. Check <a href="/health">/health</a> for how long it lasts.
        If it ever expires, this page reopens on its own.</p>
      </div>`)
  }

  return SHELL('Set up bingers-sync', `
    <h1>Connect to Bingers</h1>
    <p class="sub">bingers-sync needs a session before it can mirror anything.</p>
    ${opts.error ? `<p class="err">${esc(opts.error)}</p>` : ''}
    <div class="card">
      <ol>
        <li>Open the Bingers app and sign out, then enter your email to request a magic link.</li>
        <li>Open the email — <strong>but do not tap the link.</strong> Long-press it and choose
            <em>Copy Link</em> instead.</li>
        <li>Paste it below.</li>
      </ol>
      <p class="warn"><strong>Tapping the link spends it.</strong> The token works exactly once, so if
      the app opens it first there is nothing left for this page. Copy, don't tap.</p>
      <form method="post" action="/setup">
        <label for="link">Magic link</label>
        <input id="link" name="link" autofocus autocomplete="off" spellcheck="false"
               placeholder="https://bingers.app/m?token=…">
        <button type="submit">Connect</button>
      </form>
    </div>
    <p class="foot">The link is exchanged for a session here, on your machine.
    Nothing is sent anywhere except Bingers.</p>`)
}
