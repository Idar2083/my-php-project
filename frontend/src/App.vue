<script setup>
import { computed, onMounted, onUnmounted, provide, reactive, ref, watch, nextTick } from 'vue'
import { createApi, resource } from './api/client.js'
import Catalog from './components/Catalog.vue'
import AuthForm from './components/AuthForm.vue'
import CartView from './components/CartView.vue'
import CheckoutView from './components/CheckoutView.vue'
import OrdersView from './components/OrdersView.vue'
import RequestError from './components/RequestError.vue'
import { useServerCart } from './useServerCart.js'
import ShopHeader from './components/ShopHeader.vue'
import OrderDetails from './components/OrderDetails.vue'
import { useGuestCart } from './guestCart.js'
const view = ref('catalog')
const user = ref(null)
const busy = ref(false)
const error = ref(null)
const notice = ref('')
const guestCart = useGuestCart()
const guestCount = guestCart.count
const guestItems = guestCart.items
const storageWarning = guestCart.warning
const importError = ref(null)
const guestErrors = reactive({})
const catalogFeedback = ref(null)
const adding = ref(false)
const email = ref('')
const address = ref({ delivery_method: 'delivery' })
const submitting = ref(false)
const uncertain = ref(false)
const completedOrder = ref(null)
const catalogPosition = ref(0)
let lastProduct
let sessionCheckPending = false
let sessionSignalRevision = 0
const sessionSignal = 'pizza.session.changed'
const checkoutPending = ref(false)
let sessionRevision = 0
const restoring = ref(false)
const restoreError = ref(null)
const api = createApi(clearSession, { browserSession: true })
provide('api', api)
const server = useServerCart(api, () => user.value?.id)
const serverItems = computed(() => server.cart.value?.items)
const count = computed(() => user.value ? server.count.value : guestCount.value)
const shownItems = computed(() => user.value ? serverItems.value : guestItems.value)
const locked = computed(() => busy.value || submitting.value)
watch(view, async (current, previous) => {
  if (previous === 'catalog') catalogPosition.value = window.scrollY || 0
  await nextTick()
  const heading = document.querySelector('#shop-main h1')
  const productAction = current === 'catalog' && lastProduct &&
    document.querySelector(`[data-product-id="${lastProduct}"] .product-add`)
  const focusTarget = productAction || heading
  focusTarget?.focus({ preventScroll: true })
  if (document.scrollingElement) document.scrollingElement.scrollTop = current === 'catalog' ? catalogPosition.value : 0
})
function clearSession() {
  sessionRevision++
  server.reset()
  email.value = ''
  address.value = { delivery_method: 'delivery' }
  uncertain.value = false
  submitting.value = false
  completedOrder.value = null
  importError.value = null
  catalogFeedback.value = null
  restoreError.value = null
  api.reset()
  if (user.value) {
    view.value = 'login'
    notice.value = 'Сессия завершена. Войдите снова.'
  }
  user.value = null
}
async function restoreSession() {
  if (locked.value || restoring.value) return
  const revision = sessionRevision
  restoring.value = true
  restoreError.value = null
  try {
    const profile = await api.request('/me', { authenticated: false })
    if (revision !== sessionRevision || busy.value) return
    if (!profile?.id || !['user', 'admin'].includes(profile.role)) throw new Error('Не удалось проверить сессию.')
    if (user.value && user.value.id !== profile.id) {
      clearSession()
      view.value = 'catalog'
      notice.value = ''
    }
    if (checkoutPending.value && ['login', 'register'].includes(view.value)) {
      restoring.value = false
      await authenticated(profile, false)
      return
    }
    if (['login', 'register'].includes(view.value) || (view.value === 'admin' && profile.role !== 'admin')) {
      view.value = 'catalog'
    }
    user.value = profile
    restoreOrderReview(profile.id)
    if (!server.loading.value) void server.refresh()
  } catch (failure) {
    if (revision !== sessionRevision || busy.value) return
    if (failure.status === 401) {
      if (user.value) clearSession()
    } else {
      restoreError.value = failure.status === 403
        ? new Error('Проверка сессии недоступна. Каталог и гостевая корзина работают.')
        : failure
    }
  } finally {
    restoring.value = false
  }
}
function restoreOnVisibility() {
  if (document.visibilityState === 'visible') void restoreSession()
}
function notifySessionChange() {
  try { localStorage.setItem(sessionSignal, `${Date.now()}-${Math.random()}`) } catch { /* Recheck on visibility. */ }
}
function sessionMarker() {
  try { return localStorage.getItem(sessionSignal) } catch { return null }
}
function sessionChanged(event) {
  if (event.key !== sessionSignal) return
  sessionSignalRevision++
  if (locked.value || restoring.value) sessionCheckPending = true
  else void restoreSession()
}
watch([locked, restoring], ([isLocked, checking]) => {
  if (isLocked || checking || !sessionCheckPending) return
  sessionCheckPending = false
  void restoreSession()
})
void restoreSession()
onMounted(() => {
  document.addEventListener('visibilitychange', restoreOnVisibility)
  window.addEventListener('storage', sessionChanged)
})
onUnmounted(() => {
  document.removeEventListener('visibilitychange', restoreOnVisibility)
  window.removeEventListener('storage', sessionChanged)
})
function navigate(target) {
  if (locked.value) return
  if (['account', 'orders', 'admin'].includes(target) && !user.value) target = 'login'
  if (!['login', 'register'].includes(target)) checkoutPending.value = false
  if (target === 'admin' && user.value?.role !== 'admin') target = 'catalog'
  view.value = target; error.value = null; notice.value = ''
  if (target === 'cart' && user.value && !server.loading.value) void server.refresh()
}
async function authenticated(profile, notify = true) {
  if (user.value?.id !== profile.id) server.reset()
  sessionRevision++
  restoreError.value = null
  api.reset()
  user.value = profile
  restoreOrderReview(profile.id)
  if (notify) notifySessionChange()
  await guestCart.ready
  view.value = guestCount.value || checkoutPending.value ? 'cart' : 'catalog'
  error.value = null
  notice.value = 'Вы вошли в аккаунт.'
  await server.refresh()
  const imported = await importGuestCart(false)
  if (imported && checkoutPending.value) await startCheckout()
}

async function guestAction(item, action) {
  delete guestErrors[item.id]
  try { await action() }
  catch (failure) { guestErrors[item.id] = failure }
}

async function addProduct(product, quantity) {
  if (locked.value || restoring.value || adding.value || (user.value && server.loading.value)) return
  adding.value = true
  lastProduct = product.id
  const revision = sessionRevision
  catalogFeedback.value = { id: product.id, pending: true }
  try {
    if (user.value) {
      if (!await server.add(product, quantity)) throw server.error.value ?? new Error('Не удалось добавить товар.')
    } else await guestCart.add(product, quantity)
    if (revision === sessionRevision) catalogFeedback.value = { id: product.id, added: true }
  } catch (failure) {
    if (revision === sessionRevision) catalogFeedback.value = { id: product.id, error: failure }
  } finally {
    adding.value = false
  }
}

async function startCheckout() {
  if (locked.value || restoring.value || server.loading.value || !shownItems.value?.length) return
  if (!user.value) {
    checkoutPending.value = true
    navigate('login')
    return
  }
  busy.value = true
  try {
    const before = cartSignature()
    if (!await server.refresh() || !user.value) return
    if (before !== cartSignature()) {
      error.value = new Error('Корзина изменилась. Проверьте состав перед оформлением.')
      return
    }
    checkoutPending.value = false
    view.value = 'checkout'
  } finally { busy.value = false }
}

function cartSignature() {
  return JSON.stringify(serverItems.value?.map(item => [item.id, item.quantity, item.product.price]).sort(([a], [b]) => a - b))
}

async function importGuestCart(retry = true) {
  await guestCart.ready
  if (!guestCount.value) return true
  if (locked.value || !user.value || server.loading.value) return false
  const id = user.value.id
  const revision = sessionRevision
  const signalRevision = sessionSignalRevision
  const marker = sessionMarker()
  const stillCurrent = () => revision === sessionRevision && user.value?.id === id &&
    signalRevision === sessionSignalRevision && marker === sessionMarker()
  busy.value = true
  importError.value = null
  let attempt
  let committed = false
  let needsReview = false
  try {
    if (retry && !await server.refresh()) throw server.error.value ?? new Error('Не удалось проверить корзину.')
    attempt = await guestCart.beginImport(id, retry)
    if (!attempt) throw new Error('Проверьте корзину аккаунта перед повтором. Перенос мог выполняться в другой вкладке.')
    needsReview = true
    const current = await api.request('/me', { authenticated: false })
    if (current?.id !== id || !stillCurrent()) {
      sessionCheckPending = true
      throw new Error('Аккаунт изменился. Проверьте корзину перед повтором переноса.')
    }
    const result = await server.import(attempt.items.map(({ id, quantity }) => ({ product_id: id, quantity })), id)
    if (!result) {
      if (server.error.value?.status === 409) sessionCheckPending = true
      throw server.error.value ?? new Error('Результат переноса не подтверждён. Проверьте корзину аккаунта.')
    }
    if (result.user_id !== id || !attempt.items.every(row => result.items.some(item =>
      (item.product_id ?? item.product?.id) === row.id && item.quantity >= row.quantity))) {
      throw new Error('Состав переноса не подтверждён. Проверьте корзину аккаунта.')
    }
    const after = await api.request('/me', { authenticated: false })
    committed = after?.id === id && stillCurrent()
    if (!committed) {
      sessionCheckPending = true
      throw new Error('Аккаунт изменился во время переноса. Гостевые позиции сохранены.')
    }
  } catch (failure) {
    if (failure.status === 422) needsReview = true
    if (revision === sessionRevision) {
      importError.value = failure
      view.value = 'cart'
    }
  } finally {
    try {
      if (attempt) committed = await guestCart.finishImport(attempt, committed, needsReview && !committed, stillCurrent)
    } catch {
      committed = false
      if (revision === sessionRevision) importError.value = new Error('Не удалось сохранить результат переноса на этом устройстве.')
    } finally { busy.value = false }
  }
  return committed
}

function restoreOrderReview(id) {
  try { if (sessionStorage.getItem(`pizza.order-review.${id}`)) uncertain.value = true }
  catch { /* The review stays in memory when storage is unavailable. */ }
}

function markOrderReview(id, pending) {
  uncertain.value = pending
  const key = `pizza.order-review.${id}`
  try {
    if (pending) sessionStorage.setItem(key, '1')
    else sessionStorage.removeItem(key)
  } catch { /* The review stays in memory when storage is unavailable. */ }
}

function showConfirmedOrder(order) {
  markOrderReview(user.value.id, false)
  completedOrder.value = order
  address.value = { delivery_method: 'delivery' }
  error.value = null
  view.value = 'confirmation'
  notice.value = `Заказ №${order.id} оформлен.`
  void server.refresh()
}

async function submitOrder() {
  if (locked.value || uncertain.value || !user.value || server.loading.value || !serverItems.value?.length) return
  const revision = sessionRevision
  submitting.value = true
  error.value = null
  try {
    const before = cartSignature()
    if (!await server.refresh() || revision !== sessionRevision) {
      if (revision === sessionRevision) error.value = server.error.value ?? new Error('Не удалось проверить корзину.')
      return
    }
    if (before !== cartSignature()) {
      view.value = 'cart'
      error.value = new Error('Корзина изменилась. Проверьте состав перед оформлением.')
      return
    }
    markOrderReview(user.value.id, true)
    const order = resource(await api.request('/orders', { method: 'POST', body: address.value }))
    if (revision !== sessionRevision) return
    if (!order.id || !Array.isArray(order.items) || !order.status ||
      order.total_price == null || !Number.isFinite(Number(order.total_price))) {
      throw new Error('Неполный ответ заказа.')
    }
    showConfirmedOrder(order)
  } catch (failure) {
    if (revision !== sessionRevision) return
    markOrderReview(user.value.id, !failure.status || failure.status >= 500)
    error.value = uncertain.value
      ? new Error('Не удалось подтвердить, создан ли заказ. Проверьте историю и корзину перед повтором.')
      : failure
  } finally {
    if (revision === sessionRevision) submitting.value = false
  }
}

async function verifyOrderState() {
  await server.refresh()
}

function confirmOrderFromHistory(order) {
  if (view.value === 'orders' && uncertain.value && user.value) showConfirmedOrder(order)
}
async function logout() {
  if (locked.value) return
  busy.value = true; error.value = null
  try {
    await api.request('/logout', { method: 'POST' })
    clearSession()
    notifySessionChange()
    checkoutPending.value = false
    view.value = 'catalog'
    notice.value = 'Вы вышли из аккаунта.'
  } catch (failure) {
    if (!failure.status || failure.status >= 500) {
      try { await api.request('/me', { authenticated: false }) }
      catch (verification) {
        if (verification.status === 401) {
          clearSession()
          notifySessionChange()
          view.value = 'catalog'
          notice.value = 'Вы вышли из аккаунта.'
          return
        }
      }
    }
    if (failure.status !== 401) error.value = failure
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <div class="shop-shell">
    <a class="skip-link" href="#shop-main">К содержимому</a>
    <ShopHeader :user="user" :count="count" :busy="locked" :restoring="restoring" :view="view"
      @navigate="navigate" @logout="logout" />
    <div class="feedback">
      <p v-if="restoring" role="status">Проверяем сессию…</p>
      <RequestError :error="restoreError" />
      <button v-if="restoreError" :disabled="busy" @click="restoreSession">Повторить проверку сессии</button>
      <RequestError v-if="view !== 'checkout'" :error="error" />
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="storageWarning" class="notice warning" role="status">{{ storageWarning }}</p>
    </div>
    <main id="shop-main">
      <KeepAlive>
        <Catalog v-if="view === 'catalog'" :busy="locked || restoring || adding || (!!user && server.loading.value)"
          :items="shownItems" :feedback="catalogFeedback" @add="addProduct" @cart="navigate('cart')" />
      </KeepAlive>
      <AuthForm v-if="view === 'login' || view === 'register'" :key="view" v-model:email="email"
        :register="view === 'register'" :checkout="checkoutPending"
        @switch="navigate(view === 'register' ? 'login' : 'register')" @authenticated="authenticated" @busy="busy = $event" />
      <CartView v-else-if="view === 'cart'" :items="shownItems" :guest-items="user ? guestItems : []"
        :busy="locked || restoring" :loading="!!user && server.loading.value" :pending="server.pending" :paused="server.paused" @retry-row="server.retryRow"
        :error="server.error.value" :import-error="importError" :errors="user ? server.rowErrors : guestErrors"
        :guest-errors="guestErrors" @catalog="navigate('catalog')" @checkout="startCheckout" @retry="server.refresh"
        @import="importGuestCart()" @adjust="(item, delta) => user ? server.adjust(item.id, delta) : guestAction(item, () => guestCart.adjust(item, delta))"
        @remove="item => user ? server.remove(item.id) : guestAction(item, () => guestCart.remove(item.id))"
        @guest-adjust="(item, delta) => guestAction(item, () => guestCart.adjust(item, delta))"
        @guest-remove="item => guestAction(item, () => guestCart.remove(item.id))" />
      <section v-else-if="view === 'account' && user" class="panel narrow">
        <h1>Личный кабинет</h1>
        <p>{{ user.name }}</p>
        <p v-if="user.email">{{ user.email }}</p>
        <button @click="navigate('orders')">Мои заказы</button>
      </section>
      <CheckoutView v-else-if="view === 'checkout' && user" v-model="address" :items="serverItems"
        :busy="submitting" :error="error || server.error.value" :uncertain="uncertain" @submit="submitOrder"
        @verify="verifyOrderState" @history="navigate('orders')" @cart="navigate('cart')" />
      <section v-else-if="view === 'confirmation' && completedOrder">
        <h1 tabindex="-1">Заказ оформлен</h1>
        <OrderDetails :order="completedOrder" />
        <div class="actions"><button @click="navigate('orders')">Мои заказы</button>
          <button class="secondary" @click="navigate('catalog')">В каталог</button></div>
      </section>
      <OrdersView v-else-if="view === 'orders' && user" key="buyer-orders"
        :review-order="uncertain" @confirm-order="confirmOrderFromHistory" />
      <OrdersView v-else-if="view === 'admin' && user?.role === 'admin'" key="admin-orders" admin />
    </main>
  </div>
</template>
