import { describe, it, expect, vi } from 'vitest'
import { notify } from '../src/notify.js'

describe('notify', () => {
  it('does nothing beyond logging when no url is configured', async () => {
    const f = vi.fn()
    await notify(null, 'hello', f as any)
    expect(f).not.toHaveBeenCalled()
  })

  it('posts the text as JSON to the configured url via the injected fetch', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }))
    await notify('https://hooks.example/notify', 'writes halted', f as any)
    expect(f).toHaveBeenCalledTimes(1)
    const [url, init] = (f as any).mock.calls[0]
    expect(url).toBe('https://hooks.example/notify')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/json')
    expect(JSON.parse(init.body)).toEqual({ text: 'writes halted' })
  })

  it('swallows a network failure so the caller is never blocked by notification', async () => {
    const f = vi.fn(async () => { throw new Error('network down') })
    await expect(notify('https://hooks.example/notify', 'hello', f as any)).resolves.toBeUndefined()
  })
})
