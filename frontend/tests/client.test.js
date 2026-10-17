import { describe, expect, it, vi } from 'vitest'
import { createApi } from '../src/api/client.js'

describe('JWT API client', () => {
  it('uses an Authorization header only for authenticated requests and never stores a token', async () => {
    const fetch = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal('fetch', fetch)
    const storage = vi.spyOn(Storage.prototype, 'setItem')
    const api = createApi()
    api.setToken('test-jwt')
    await api.request('/cart')
    await api.request('/login', { method: 'POST', body: { email: 'buyer@example.test' }, authenticated: false })
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer test-jwt')
    expect(fetch.mock.calls[1][1].headers.Authorization).toBeUndefined()
    expect(fetch.mock.calls[0][1].cache).toBe('no-store')
    expect(storage).not.toHaveBeenCalled()
    expect(fetch.mock.calls[0][0]).toBe('/api/cart')
  })

  it('invalidates expired sessions, but not a failed login', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401 }))
    const expired = vi.fn()
    const api = createApi(expired)
    await expect(api.request('/login', { authenticated: false })).rejects.toMatchObject({ status: 401 })
    expect(expired).not.toHaveBeenCalled()
    await expect(api.request('/me')).rejects.toMatchObject({ status: 401 })
    expect(expired).toHaveBeenCalledOnce()
  })

  it('rejects late private responses after the session changes', async () => {
    let resolve
    vi.stubGlobal('fetch', vi.fn(() => new Promise(done => { resolve = done })))
    const api = createApi()
    api.setToken('old')
    const request = api.request('/orders')
    api.setToken(null)
    resolve({ ok: true, json: async () => ({ data: ['private'] }) })
    await expect(request).rejects.toMatchObject({ status: 401 })
  })

  it('does not expose raw server debug errors and extracts validation errors only for 422', async () => {
    const json = vi.fn(async () => ({ message: 'SQL password=secret', errors: { quantity: ['Количество должно быть не больше 10.'] } }))
    const fetch = vi.fn().mockResolvedValueOnce({ ok: false, status: 500, json }).mockResolvedValueOnce({ ok: false, status: 422, json })
    vi.stubGlobal('fetch', fetch)
    const api = createApi()
    await expect(api.request('/orders')).rejects.not.toThrow('secret')
    expect(json).not.toHaveBeenCalled()
    await expect(api.request('/cart/items')).rejects.toMatchObject({ errors: ['Количество должно быть не больше 10.'] })
  })

  it('times out without an automatic retry', async () => {
    vi.useFakeTimers()
    const fetch = vi.fn((url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))))
    vi.stubGlobal('fetch', fetch)
    const pending = expect(createApi().request('/orders')).rejects.toMatchObject({ status: 0 })
    await vi.advanceTimersByTimeAsync(15000)
    await pending
    expect(fetch).toHaveBeenCalledOnce()
    vi.useRealTimers()
  })
})
