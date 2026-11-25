import { computed, reactive, ref } from 'vue'
import { resource } from './api/client.js'

export function useServerCart(api, account) {
  const cart = ref(null)
  const error = ref(null)
  const rowErrors = reactive({})
  const pending = reactive({})
  const paused = reactive(new Set())
  const running = ref(false)
  const reading = ref(false)
  const loading = computed(() => reading.value || running.value || Object.keys(pending).length > 0)
  const count = computed(() => cart.value?.items.reduce((sum, item) => sum + item.quantity, 0))
  let epoch = 0
  let version = 0
  let read
  let timer

  function accept(response, id) {
    const result = resource(response)
    if (!Array.isArray(result.items) || (result.user_id != null && result.user_id !== id)) {
      throw new Error('Не удалось подтвердить состояние корзины аккаунта.')
    }
    cart.value = result
    version++
    return result
  }

  function reset() {
    epoch++
    version++
    clearTimeout(timer)
    paused.clear()
    cart.value = error.value = null
    for (const key of Object.keys(pending)) delete pending[key]
    for (const key of Object.keys(rowErrors)) delete rowErrors[key]
    read = null
    reading.value = running.value = false
  }

  function refresh() {
    if (!account()) return Promise.resolve(false)
    if (read) return read
    const revision = epoch
    const before = version
    const id = account()
    reading.value = true
    error.value = null
    read = (async () => {
      try {
        const response = await api.request('/cart')
        if (revision !== epoch || id !== account() || before !== version) return false
        accept(response, id)
        return true
      } catch (failure) {
        if (revision === epoch && before === version) error.value = failure
        return false
      } finally {
        if (revision === epoch) {
          read = null
          reading.value = false
        }
      }
    })()
    return read
  }

  async function mutate(path, method, body, row, options = {}) {
    if (running.value || !account()) return false
    const revision = epoch
    const id = account()
    version++
    running.value = true
    error.value = null
    if (row != null) delete rowErrors[row]
    try {
      const response = await api.request(path, { method, ...(body === undefined ? {} : { body }), ...options })
      if (revision !== epoch || account() !== id) return false
      return accept(response, id)
    } catch (failure) {
      if (revision !== epoch) return false
      if (row != null) rowErrors[row] = failure
      else error.value = failure
      if (!failure.status || failure.status >= 500 || failure.status === 404) {
        await read
        const reconciled = await refresh()
        if (revision !== epoch) return false
        if (row == null) error.value = failure
        else return { ambiguous: true, reconciled }
      }
      return false
    } finally {
      if (revision === epoch) {
        running.value = false
        schedule()
      }
    }
  }

  function schedule() {
    clearTimeout(timer)
    if (Object.keys(pending).some(id => !paused.has(id))) timer = setTimeout(drain, 200)
  }

  function confirmed(id) {
    return cart.value?.items.find(item => String(item.id) === String(id))
  }

  function adjust(id, delta) {
    const item = confirmed(id)
    if (!item || pending[id]?.remove) return
    const quantity = (pending[id]?.quantity ?? item.quantity) + delta
    if (quantity < 1 || quantity > 30) return
    if (!paused.has(String(id))) delete rowErrors[id]
    pending[id] = { quantity }
    schedule()
  }

  function remove(id) {
    if (!confirmed(id)) return
    pending[id] = { remove: true }
    paused.delete(String(id))
    schedule()
  }

  async function drain() {
    if (running.value) return
    const id = Object.keys(pending).find(key => !paused.has(key))
    if (id === undefined) return
    const revision = epoch
    for (let attempt = 0; attempt < 2; attempt++) {
      const action = pending[id]
      const item = confirmed(id)
      if (!item || (!action.remove && action.quantity === item.quantity)) {
        delete pending[id]
        delete rowErrors[id]
        break
      }
      const method = action.remove ? 'DELETE' : 'PUT'
      const result = await mutate(`/cart/items/${id}`, method,
        action.remove ? undefined : { quantity: action.quantity }, id)
      if (revision !== epoch) return
      if (result?.ambiguous) {
        if (result.reconciled && (!confirmed(id) || pending[id]?.quantity === confirmed(id).quantity)) {
          delete pending[id]
          delete rowErrors[id]
          break
        }
        if (result.reconciled && attempt === 0) continue
        paused.add(id)
      } else if (pending[id] === action || (!result && !pending[id]?.remove)) {
        delete pending[id]
      }
      break
    }
    schedule()
  }

  async function retryRow(id) {
    const key = String(id)
    if (!paused.has(key) || running.value || reading.value) return
    const revision = epoch
    if (!await refresh() || revision !== epoch) return
    paused.delete(key)
    schedule()
  }

  return { cart, count, error, rowErrors, pending, paused, loading, refresh, reset, adjust, remove, retryRow,
    add: (product, quantity) => mutate('/cart/items', 'POST', { product_id: product.id, quantity }),
    import: (items, owner) => mutate('/cart/import', 'POST', { items }, undefined, { importOwner: owner }),
  }
}
