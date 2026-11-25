import { computed, onMounted, onUnmounted, ref } from 'vue'
import { changeKey, legacyKey, openGuestCart, transact } from './guestCartStorage.js'

const limits = { pizza: 10, drink: 20 }
const empty = () => ({ items: [], revision: 0, attempt: null })
const importWindow = 60000

function legacyItems(raw) {
  const parsed = JSON.parse(raw)
  if (!Array.isArray(parsed)) throw new Error('Некорректный формат корзины.')
  const seen = new Set()
  return parsed.filter(row => {
    const { product, quantity } = row ?? {}
    if (!Number.isSafeInteger(product?.id) || product.id < 1 || seen.has(product.id) ||
      typeof product.name !== 'string' || !Number.isFinite(product.price) || product.price < 0 ||
      !Object.hasOwn(limits, product.category) || !Number.isSafeInteger(quantity) ||
      quantity < 1 || quantity > limits[product.category]) return false
    seen.add(product.id)
    return true
  }).map(({ product, quantity }) => ({ id: product.id, product, quantity, revision: 0 }))
}

export function useGuestCart() {
  const snapshot = ref(empty())
  const items = computed(() => snapshot.value.items)
  const count = computed(() => items.value.reduce((sum, item) => sum + item.quantity, 0))
  const warning = ref('')
  let database
  let temporary
  let disposed = false
  let fallbackQueue = Promise.resolve()

  function apply(state) {
    if (state && state.revision >= snapshot.value.revision) snapshot.value = state
  }

  const ready = (async () => {
    let raw = null
    try { raw = localStorage.getItem(legacyKey) } catch { /* Optional migration source. */ }
    try {
      database = await openGuestCart()
      let importedLegacy = false
      const state = await transact(database, current => {
        if (current) return current
        let rows = []
        if (raw !== null) {
          try {
            rows = legacyItems(raw)
            importedLegacy = rows.length === JSON.parse(raw).length
          } catch { /* Keep the original key for recovery. */ }
        }
        return { ...empty(), items: rows }
      })
      apply(state)
      try {
        if (importedLegacy && localStorage.getItem(legacyKey) === raw) localStorage.removeItem(legacyKey)
        else if (localStorage.getItem(legacyKey) !== null) {
          warning.value = 'Есть сохранённые данные старой версии. Обновите другие вкладки. Исходные данные сохранены.'
        }
      } catch { /* The original remains available. */ }
    } catch {
      database?.close()
      database = undefined
      temporary = empty()
      if (raw !== null) {
        try { temporary.items = legacyItems(raw) } catch { /* Preserve the original for recovery. */ }
      }
      apply(temporary)
      warning.value = 'Хранилище недоступно. Изменения корзины действуют только в этой вкладке и могут исчезнуть после обновления.'
    }
    if (disposed) database?.close()
  })()

  async function refresh() {
    await ready
    if (!database || disposed) return
    try { apply(await transact(database)) }
    catch { warning.value = 'Не удалось прочитать сохранённую корзину. Обновите страницу и повторите действие.' }
  }

  async function update(change) {
    await ready
    const next = current => {
      current ??= empty()
      const revision = current.revision + 1
      return { ...current, ...change(current, revision), revision }
    }
    if (!database) {
      const operation = fallbackQueue.then(() => { temporary = next(temporary); apply(temporary) })
      fallbackQueue = operation.catch(() => {})
      return operation
    }
    apply(await transact(database, next))
    try { localStorage.setItem(changeKey, String(snapshot.value.revision)) } catch { /* Refresh on focus. */ }
  }

  function changeItem(product, delta, existingOnly) {
    return update((state, revision) => {
      const item = state.items.find(row => row.id === product.id)
      if (!item && existingOnly) throw new Error('Позиция уже удалена в другой вкладке.')
      assertEditable(state, product.id)
      const category = product.category.trim().toLowerCase()
      const limit = Object.hasOwn(limits, category) ? limits[category] : 0
      const quantity = (item?.quantity ?? 0) + delta
      const others = state.items.filter(row => row.id !== product.id)
      const total = others.reduce((sum, row) => sum + (row.product.category === category ? row.quantity : 0), 0)
      if (!limit || !Number.isSafeInteger(quantity) || quantity < 1 || total + quantity > limit) {
        throw new Error(limit ? `Допустимое количество в категории — до ${limit}.` : 'Товар недоступен для добавления.')
      }
      const row = { id: product.id, product: { id: product.id, name: product.name, price: product.price, category }, quantity, revision }
      return { items: item ? state.items.map(saved => saved.id === row.id ? row : saved) : [...others, row] }
    })
  }

  function assertEditable(state, id) {
    if (state.attempt?.expires > Date.now() && state.attempt.items.some(row => row.id === id)) {
      throw new Error('Позиция переносится в корзину аккаунта. Дождитесь результата.')
    }
  }

  async function beginImport(accountId, retry) {
    let attempt
    await update(state => {
      if (state.attempt?.expires > Date.now() || !state.items.length || (!retry && (state.attempt || state.review))) return {}
      attempt = {
        id: state.revision + 1, accountId, expires: Date.now() + importWindow,
        items: state.items.map(({ id, quantity, revision }) => ({ id, quantity, revision })),
      }
      return { attempt }
    })
    return attempt
  }

  async function finishImport(attempt, success, review, stillCurrent = () => true) {
    let confirmed = false
    await update(state => {
      if (state.attempt?.id !== attempt.id) return {}
      confirmed = success && stillCurrent()
      return {
        attempt: null, review: review || (success && !confirmed),
        items: confirmed ? state.items.filter(row => !attempt.items.some(item => item.id === row.id && item.revision === row.revision)) : state.items,
      }
    })
    return confirmed
  }

  function storage(event) {
    if (event.key === changeKey || event.key === null) void refresh()
    if (event.key === legacyKey && event.newValue !== null && database) {
      warning.value = 'Старая вкладка изменила гостевую корзину. Обновите её. Снимок старой версии сохранён.'
    }
  }

  onMounted(() => {
    window.addEventListener('storage', storage)
    window.addEventListener('pageshow', refresh)
    document.addEventListener('visibilitychange', refresh)
  })
  onUnmounted(() => {
    disposed = true
    database?.close()
    window.removeEventListener('storage', storage)
    window.removeEventListener('pageshow', refresh)
    document.removeEventListener('visibilitychange', refresh)
  })

  return {
    items, count, ready, warning, refresh, beginImport, finishImport,
    add: (product, quantity = 1) => changeItem(product, quantity, false),
    adjust: (item, delta) => changeItem(item.product, delta, true),
    remove: id => update(state => {
      assertEditable(state, id)
      return { items: state.items.filter(row => row.id !== id) }
    }),
  }
}
