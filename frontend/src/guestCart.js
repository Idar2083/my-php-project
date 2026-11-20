import { computed, ref } from 'vue'

const storageKey = 'pizza.guest-cart'
const limits = { pizza: 10, drink: 20 }

function readItems() {
  try {
    const stored = JSON.parse(localStorage.getItem(storageKey))
    if (!Array.isArray(stored)) return []
    const items = []
    for (const item of stored.slice(0, 30)) {
      const { product, quantity } = item || {}
      if (Number.isSafeInteger(product?.id) && product.id > 0 && typeof product.name === 'string' &&
          Number.isFinite(product.price) && product.price >= 0 && Object.hasOwn(limits, product.category) &&
          Number.isSafeInteger(quantity) && quantity > 0 && quantity <= limits[product.category] &&
          !items.some(saved => saved.id === product.id)) {
        items.push({ id: product.id, product, quantity })
      }
    }
    return items
  } catch {
    return []
  }
}

export function useGuestCart() {
  const items = ref(readItems())
  const count = computed(() => items.value.reduce((sum, item) => sum + item.quantity, 0))

  function save(next) {
    items.value = next
    try { localStorage.setItem(storageKey, JSON.stringify(next)) } catch { /* In-memory fallback. */ }
  }

  function setQuantity(product, quantity) {
    const category = product.category.trim().toLowerCase()
    const limit = Object.hasOwn(limits, category) ? limits[category] : 0
    const others = items.value.filter(item => item.id !== product.id)
    const total = others.reduce((sum, item) => sum + (item.product.category === category ? item.quantity : 0), 0)
    if (!limit) throw new Error('Этот товар недоступен для добавления.')
    if (!Number.isSafeInteger(quantity) || quantity < 1 || total + quantity > limit) {
      throw new Error(`Допустимое количество товаров в этой категории — до ${limit}.`)
    }
    const item = { id: product.id, quantity, product: { id: product.id, name: product.name, price: product.price, category } }
    save(items.value.some(saved => saved.id === product.id)
      ? items.value.map(saved => saved.id === product.id ? item : saved)
      : [...items.value, item])
  }

  return {
    items, count, setQuantity,
    add: product => setQuantity(product, (items.value.find(item => item.id === product.id)?.quantity ?? 0) + 1),
    remove: id => save(items.value.filter(item => item.id !== id)),
    clear: () => save([]),
  }
}
