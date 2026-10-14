import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../src/App.vue'
import { jsonResponse, product, productPage } from './fixtures.js'

let wrapper

afterEach(() => {
  wrapper?.unmount()
  vi.useRealTimers()
})

describe('catalog page', () => {
  it('shows loading until the request completes, then real product fields', async () => {
    let resolve
    vi.stubGlobal('fetch', vi.fn(() => new Promise((done) => { resolve = done })))
    wrapper = mount(App)
    expect(wrapper.get('[role="status"]').text()).toContain('Загружаем товары')
    expect(wrapper.find('article').exists()).toBe(false)
    resolve(jsonResponse(productPage()))
    await flushPromises()
    expect(wrapper.find('[role="status"]').exists()).toBe(false)
    const card = wrapper.get('article').text()
    for (const field of ['Pepperoni', '799', 'pizza', 'Томатный соус', '0.550']) {
      expect(card).toContain(field)
    }
  })

  it('shows empty rather than an error for successful empty data', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(productPage([]))))
    wrapper = mount(App)
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('Товаров пока нет')
    expect(wrapper.find('[role="alert"]').exists()).toBe(false)
  })

  it.each([
    () => Promise.reject(new TypeError('Network failed')),
    () => Promise.resolve({ ok: false, status: 500 }),
    () => Promise.resolve(jsonResponse({ data: [] })),
    () => Promise.resolve({ ok: true, json: () => Promise.reject(new SyntaxError('Invalid JSON')) }),
  ])('shows a safe error and supports retry through loading to success', async (failure) => {
    let retry
    const fetch = vi.fn().mockImplementationOnce(failure)
      .mockImplementationOnce(() => new Promise((resolve) => { retry = resolve }))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Не удалось загрузить товары')
    await wrapper.get('button').trigger('click')
    expect(wrapper.get('[role="status"]').text()).toContain('Загружаем товары')
    retry(jsonResponse(productPage()))
    await flushPromises()
    expect(wrapper.get('article').text()).toContain(product.name)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('navigates using meta and its own API base rather than server-origin links', async () => {
    const first = productPage([product], { last_page: 2, total: 31 })
    first.links.next = 'http://nginx/api/products?page=2'
    const second = productPage([{ ...product, id: 8, name: 'Напиток' }], { current_page: 2, last_page: 2, total: 31 })
    const fetch = vi.fn().mockResolvedValueOnce(jsonResponse(first)).mockResolvedValueOnce(jsonResponse(second))
    vi.stubGlobal('fetch', fetch)
    vi.stubEnv('VITE_API_BASE_URL', '/api')
    wrapper = mount(App)
    await flushPromises()
    expect(wrapper.get('nav button').attributes('disabled')).toBeDefined()
    await wrapper.findAll('nav button')[1].trigger('click')
    await flushPromises()
    expect(fetch.mock.calls[1][0]).toBe('/api/products?page=2')
    expect(wrapper.get('article').text()).toContain('Напиток')
    expect(wrapper.get('nav').text()).toContain('Страница 2 из 2')
    expect(wrapper.findAll('nav button')[1].attributes('disabled')).toBeDefined()
  })

  it('times out a hung API request and shows retry', async () => {
    vi.useFakeTimers()
    vi.stubGlobal('fetch', vi.fn((url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')))
    })))
    wrapper = mount(App)
    await vi.advanceTimersByTimeAsync(10000)
    expect(wrapper.get('[role="alert"]').text()).toContain('Повторить загрузку')
  })

  it('aborts the active request when unmounted', () => {
    const fetch = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    const signal = fetch.mock.calls[0][1].signal
    wrapper.unmount()
    wrapper = null
    expect(signal.aborted).toBe(true)
  })

  it('recovers from a removed last page with exactly one additional request', async () => {
    let recover
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(productPage([product], { last_page: 2, total: 31 })))
      .mockResolvedValueOnce(jsonResponse(productPage([], { current_page: 2, total: 30 })))
      .mockImplementationOnce(() => new Promise((resolve) => { recover = resolve }))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll('nav button')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('Загружаем товары')
    expect(wrapper.text()).not.toContain('Товаров пока нет')
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      '/api/products?page=1', '/api/products?page=2', '/api/products?page=1',
    ])
    recover(jsonResponse(productPage([product], { total: 30 })))
    await flushPromises()
    expect(wrapper.get('article').text()).toContain(product.name)
    expect(wrapper.find('nav').exists()).toBe(false)
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('shows empty without extra requests when the entire catalog disappears', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(productPage([product], { last_page: 2, total: 31 })))
      .mockResolvedValueOnce(jsonResponse(productPage([], { current_page: 2 })))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll('nav button')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="status"]').text()).toContain('Товаров пока нет')
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('stops recovery after one request if the catalog keeps shrinking and allows manual retry', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(productPage([product], { last_page: 3, total: 61 })))
      .mockResolvedValueOnce(jsonResponse(productPage([product], { current_page: 2, last_page: 3, total: 61 })))
      .mockResolvedValueOnce(jsonResponse(productPage([], { current_page: 3, last_page: 2, total: 31 })))
      .mockResolvedValueOnce(jsonResponse(productPage([], { current_page: 2, total: 30 })))
      .mockResolvedValueOnce(jsonResponse(productPage([], { current_page: 2, total: 30 })))
      .mockResolvedValueOnce(jsonResponse(productPage([product], { total: 30 })))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll('nav button')[1].trigger('click')
    await flushPromises()
    await wrapper.findAll('nav button')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Повторить загрузку')
    expect(wrapper.text()).not.toContain('Товаров пока нет')
    expect(fetch).toHaveBeenCalledTimes(4)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(fetch.mock.calls[4][0]).toBe('/api/products?page=2')
    expect(fetch).toHaveBeenCalledTimes(6)
    expect(wrapper.get('article').text()).toContain(product.name)
  })

  it.each([
    productPage([], { total: 30 }),
    productPage([], { last_page: 2 }),
    productPage([product], { current_page: 2, last_page: 2, total: 31 }),
  ])('shows an error without automatic retry for contradictory responses', async (page) => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse(page))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Не удалось загрузить товары')
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('aborts a recovery request on unmount and ignores its late response', async () => {
    let resolve
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(productPage([product], { last_page: 2, total: 31 })))
      .mockResolvedValueOnce(jsonResponse(productPage([], { current_page: 2, total: 30 })))
      .mockImplementationOnce(() => new Promise((done) => { resolve = done }))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll('nav button')[1].trigger('click')
    await flushPromises()
    const signal = fetch.mock.calls[2][1].signal
    wrapper.unmount()
    wrapper = null
    expect(signal.aborted).toBe(true)
    resolve(jsonResponse(productPage([product], { total: 30 })))
    await flushPromises()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it.each([
    () => Promise.reject(new TypeError('Network failed')),
    () => Promise.resolve({ ok: false, status: 503 }),
    () => Promise.resolve(jsonResponse(productPage([], { total: 30 }))),
  ])('keeps recovery failures retryable without further automatic requests', async (failure) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(jsonResponse(productPage([product], { last_page: 2, total: 31 })))
      .mockResolvedValueOnce(jsonResponse(productPage([], { current_page: 2, total: 30 })))
      .mockImplementationOnce(failure)
      .mockResolvedValueOnce(jsonResponse(productPage([product], { total: 30 })))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    await flushPromises()
    await wrapper.findAll('nav button')[1].trigger('click')
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Повторить загрузку')
    expect(fetch).toHaveBeenCalledTimes(3)
    await wrapper.get('button').trigger('click')
    await flushPromises()
    expect(fetch.mock.calls[3][0]).toBe('/api/products?page=1')
    expect(wrapper.get('article').text()).toContain(product.name)
    expect(fetch).toHaveBeenCalledTimes(4)
  })

})
