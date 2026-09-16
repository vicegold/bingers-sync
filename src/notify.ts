export async function notify(url: string | null, text: string, fetchImpl: typeof fetch = fetch): Promise<void> {
  console.warn('[notify]', text)
  if (!url) return
  try {
    await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text }) })
  } catch { /* notification failure must never fail the request */ }
}
