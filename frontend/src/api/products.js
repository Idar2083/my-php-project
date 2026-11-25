// VITE_* values are public and are replaced at build time.
export function productsUrl(page = 1) {
  const base = (import.meta.env.VITE_API_BASE_URL || '/api').replace(/\/+$/, '')
  return `${base}/products?page=${page}`
}

export function parseProductPage(document) {
  const meta = document?.meta
  if (
    !Array.isArray(document?.data) ||
    !Number.isSafeInteger(meta?.current_page) || meta.current_page < 1 ||
    !Number.isSafeInteger(meta?.last_page) || meta.last_page < 1 ||
    !Number.isSafeInteger(meta?.total) || meta.total < 0 ||
    !Number.isSafeInteger(meta?.per_page) || meta.per_page < 1 ||
    meta.last_page !== Math.max(1, Math.ceil(meta.total / meta.per_page)) ||
    document.data.length > Math.min(meta.total, meta.per_page) ||
    (meta.current_page > meta.last_page && document.data.length > 0) ||
    (meta.total > 0 && meta.current_page <= meta.last_page && document.data.length === 0) ||
    !document.data.every((product) =>
      product && Number.isInteger(product.id) &&
      typeof product.name === 'string' &&
      typeof product.price === 'number' && Number.isFinite(product.price) &&
      typeof product.category === 'string' &&
      (product.description === null || typeof product.description === 'string') &&
      typeof product.weight === 'string',
    )
  ) {
    throw new Error('Некорректный ответ каталога')
  }

  return { products: document.data, meta }
}

export async function fetchProducts(page = 1, signal) {
  const response = await fetch(productsUrl(page), {
    headers: { Accept: 'application/json' },
    signal,
  })
  if (!response.ok) {
    throw new Error(`Каталог недоступен (HTTP ${response.status})`)
  }
  return parseProductPage(await response.json())
}
