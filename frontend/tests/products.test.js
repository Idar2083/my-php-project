import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchProducts, parseProductPage, productsUrl } from '../src/api/products.js'
import { jsonResponse, product, productPage } from './fixtures.js'

afterEach(() => vi.unstubAllEnvs())

describe('catalog API', () => {
  it('defaults to the same-origin API and builds page URLs', () => {
    vi.stubEnv('VITE_API_BASE_URL', '')
    expect(productsUrl(2)).toBe('/api/products?page=2')
  })

  it('uses the configured base path without duplicating slashes', () => {
    vi.stubEnv('VITE_API_BASE_URL', '/custom/api/')
    expect(productsUrl()).toBe('/custom/api/products?page=1')
  })

  it('accepts a configured absolute URL', () => {
    vi.stubEnv('VITE_API_BASE_URL', 'https://api.example.test/api')
    expect(productsUrl()).toBe('https://api.example.test/api/products?page=1')
  })

  it('reads the Resource data wrapper, decimal weight and pagination', async () => {
    const page = productPage([product], { last_page: 2, total: 31 })
    const fetch = vi.fn().mockResolvedValue(jsonResponse(page))
    vi.stubGlobal('fetch', fetch)
    const controller = new AbortController()
    expect(await fetchProducts(1, controller.signal)).toEqual({ products: [product], meta: page.meta })
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining('/products?page=1'), {
      headers: { Accept: 'application/json' }, signal: controller.signal,
    })
  })

  it('accepts empty data and nullable descriptions', () => {
    expect(parseProductPage(productPage([])).products).toEqual([])
    expect(parseProductPage(productPage([{ ...product, description: null }])).products[0].description).toBeNull()
  })

  it.each([
    [], {}, { data: [] }, productPage([{}]),
    productPage([], { current_page: '1' }), productPage([], { last_page: 0 }),
  ])('rejects malformed successful responses', (document) => {
    expect(() => parseProductPage(document)).toThrow('Некорректный ответ каталога')
  })

  it('rejects HTTP errors without reading or displaying backend debug output', async () => {
    const json = vi.fn()
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503, json }))
    await expect(fetchProducts()).rejects.toThrow('HTTP 503')
    expect(json).not.toHaveBeenCalled()
  })

  it('propagates network and invalid JSON errors', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Network failed')))
    await expect(fetchProducts()).rejects.toThrow('Network failed')
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => { throw new SyntaxError('Invalid JSON') } }))
    await expect(fetchProducts()).rejects.toThrow('Invalid JSON')
  })

  it('accepts an empty page beyond the last available page', () => {
    const page = productPage([], { current_page: 2, total: 30 })
    expect(parseProductPage(page)).toEqual({ products: [], meta: page.meta })
  })

  it.each([
    { per_page: 0 }, { per_page: '30' }, { total: -1 },
    { total: Number.MAX_SAFE_INTEGER + 1 }, { current_page: 1.5 },
    { last_page: 2 }, { total: 31 },
  ])('rejects invalid or inconsistent metadata: %j', (meta) => {
    expect(() => parseProductPage(productPage([], meta))).toThrow('Некорректный ответ каталога')
  })

  it.each([
    productPage([], { total: 30 }),
    productPage([product], { total: 0 }),
    productPage([product], { current_page: 2 }),
    productPage([product, { ...product, id: 8 }], { per_page: 1 }),
  ])('rejects data contradicting pagination metadata', (page) => {
    expect(() => parseProductPage(page)).toThrow('Некорректный ответ каталога')
  })

})
