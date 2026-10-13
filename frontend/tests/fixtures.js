// Same fields and serialization as ProductResource; test data only.
export const product = {
  id: 7,
  name: 'Pepperoni',
  price: 799,
  category: 'pizza',
  description: 'Томатный соус',
  weight: '0.550',
}

export function productPage(data = [product], overrides = {}) {
  return {
    data,
    links: { first: '/api/products?page=1', last: '/api/products?page=1', prev: null, next: null },
    meta: {
      current_page: 1, last_page: 1, total: data.length,
      from: data.length ? 1 : null, to: data.length || null,
      per_page: 30, path: '/api/products', links: [],
      ...overrides,
    },
  }
}

export function jsonResponse(data) {
  return { ok: true, json: async () => data }
}
