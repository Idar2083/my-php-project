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
})
