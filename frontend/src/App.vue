<script setup>
import { computed, onMounted, onUnmounted, provide, ref } from 'vue'
import { createApi, resource } from './api/client.js'
import Catalog from './components/Catalog.vue'
import AuthForm from './components/AuthForm.vue'
import CartView from './components/CartView.vue'
import CheckoutView from './components/CheckoutView.vue'
import OrdersView from './components/OrdersView.vue'
import RequestError from './components/RequestError.vue'
import { useGuestCart } from './guestCart.js'
const view = ref('catalog')
const user = ref(null)
const busy = ref(false)
const error = ref(null)
const notice = ref('')
const guestCart = useGuestCart()
const guestCount = guestCart.count
const localCart = computed(() => !user.value || guestCount.value > 0 ? guestCart.items.value : null)
const checkoutPending = ref(false)
let sessionRevision = 0
const restoring = ref(false)
const restoreError = ref(null)
const api = createApi(clearSession, { browserSession: true })
provide('api', api)
function clearSession() {
  sessionRevision++
  restoreError.value = null
  api.reset()
  if (user.value) {
    view.value = 'login'
    notice.value = 'Сессия завершена. Войдите снова.'
  }
  user.value = null
}
async function restoreSession() {
  if (busy.value || restoring.value) return
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
      await authenticated(profile)
      return
    }
    if (['login', 'register'].includes(view.value) || (view.value === 'admin' && profile.role !== 'admin')) {
      view.value = 'catalog'
    }
    user.value = profile
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
void restoreSession()
onMounted(() => {
  document.addEventListener('visibilitychange', restoreOnVisibility)
})
onUnmounted(() => document.removeEventListener('visibilitychange', restoreOnVisibility))
function navigate(target) {
  if (busy.value) return
  if (['account', 'orders', 'admin'].includes(target) && !user.value) target = 'login'
  if (!['login', 'register'].includes(target)) checkoutPending.value = false
  if (target === 'admin' && user.value?.role !== 'admin') target = 'catalog'
  view.value = target; error.value = null; notice.value = ''
}
async function authenticated(profile) {
  sessionRevision++
  restoreError.value = null
  api.reset()
  user.value = profile
  view.value = guestCount.value ? 'cart' : 'catalog'
  error.value = null; notice.value = 'Вы вошли в аккаунт.'
  if (checkoutPending.value) await startCheckout()
  else await importGuestCart()
}
function changeGuestCart(action) {
  error.value = null
  try { action(); return true }
  catch (failure) { error.value = failure; return false }
}
async function addProduct(product) {
  if (busy.value) return
  if (localCart.value) {
    if (changeGuestCart(() => guestCart.add(product))) notice.value = 'Товар добавлен в корзину.'
    else notice.value = ''
    return
  }
  busy.value = true; error.value = null; notice.value = ''
  try {
    resource(await api.request('/cart/items', { method: 'POST', body: { product_id: product.id, quantity: 1 } }))
    notice.value = 'Товар добавлен в корзину.'
  } catch (failure) { error.value = failure }
  finally { busy.value = false }
}
async function startCheckout() {
  if (busy.value) return
  if (!user.value) {
    checkoutPending.value = true
    navigate('login')
    return
  }
  if (!await importGuestCart()) return
  checkoutPending.value = false
  view.value = 'checkout'
}
async function importGuestCart() {
  if (!guestCount.value) return true
  busy.value = true; error.value = null
  const items = guestCart.items.value.map(({ id, quantity }) => ({ product_id: id, quantity }))
  try {
    resource(await api.request('/cart/import', { method: 'POST', body: { items } }))
    guestCart.clear()
    return true
  } catch (failure) {
    if (user.value) {
      view.value = 'cart'
      error.value = failure
    }
    return false
  } finally { busy.value = false }
}
async function logout() {
  if (busy.value) return
  busy.value = true; error.value = null
  try {
    await api.request('/logout', { method: 'POST' })
    clearSession()
    checkoutPending.value = false
    view.value = 'catalog'
    notice.value = 'Вы вышли из аккаунта.'
  } catch (failure) {
    if (failure.status !== 401) error.value = failure
  } finally {
    busy.value = false
  }
}
function ordered(order) {
  view.value = 'orders'; notice.value = `Заказ №${order.id} оформлен. Итоговая сумма: ${order.total_price}.`
}
</script>
<template>
  <div class="shop-shell">
    <div class="shop-bar">
      <a href="#catalog" class="brand" @click.prevent="navigate('catalog')">Pizza & drinks</a>
      <nav class="shop-nav" aria-label="Разделы магазина">
        <button class="secondary" :disabled="busy" @click="navigate('catalog')">Каталог</button>
        <button class="secondary" :disabled="busy" @click="navigate('cart')">Корзина{{ localCart ? ` (${guestCount})` : '' }}</button>
        <template v-if="user">
          <button class="secondary" :disabled="busy" @click="navigate('account')">Личный кабинет</button>
          <button class="secondary" :disabled="busy" @click="navigate('orders')">Мои заказы</button>
          <button v-if="user.role === 'admin'" class="secondary" :disabled="busy" @click="navigate('admin')">Заказы магазина</button>
          <span class="account-name">{{ user.name }}</span><button :disabled="busy" @click="logout">Выйти</button>
        </template>
        <template v-else-if="!restoring">
          <button class="secondary" :disabled="busy" @click="navigate('login')">Войти</button>
          <button :disabled="busy" @click="navigate('register')">Регистрация</button>
        </template>
      </nav>
    </div>
    <div class="feedback">
      <p v-if="restoring" role="status">Проверяем сессию…</p>
      <RequestError :error="restoreError" />
      <button v-if="restoreError" :disabled="busy" @click="restoreSession">Повторить проверку сессии</button>
      <RequestError :error="error" />
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="busy" role="status">Выполняем запрос…</p>
    </div>
    <Catalog v-if="view === 'catalog'" :busy="busy" @add="addProduct" />
    <main v-else>
      <AuthForm v-if="view === 'login' || view === 'register'" :key="view" :register="view === 'register'" :checkout="checkoutPending"
        @switch="navigate(view === 'register' ? 'login' : 'register')" @authenticated="authenticated" @busy="busy = $event" />
      <CartView v-else-if="view === 'cart'" :key="localCart ? 'local' : user?.id"
        :local-items="localCart" :transferring="busy" @checkout="startCheckout"
        @quantity="(item, quantity) => changeGuestCart(() => guestCart.setQuantity(item.product, quantity))"
        @remove="item => changeGuestCart(() => guestCart.remove(item.id))" />
      <section v-else-if="view === 'account' && user" class="panel narrow">
        <h1>Личный кабинет</h1>
        <p>{{ user.name }}</p>
        <p v-if="user.email">{{ user.email }}</p>
        <button @click="navigate('orders')">Мои заказы</button>
      </section>
      <CheckoutView v-else-if="view === 'checkout' && user" @ordered="ordered" @history="navigate('orders')" />
      <OrdersView v-else-if="view === 'orders' && user" key="buyer-orders" />
      <OrdersView v-else-if="view === 'admin' && user?.role === 'admin'" key="admin-orders" admin />
    </main>
  </div>
</template>
