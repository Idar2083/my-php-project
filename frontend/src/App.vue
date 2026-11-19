<script setup>
import { onMounted, onUnmounted, provide, ref } from 'vue'
import { createApi, resource } from './api/client.js'
import Catalog from './components/Catalog.vue'
import AuthForm from './components/AuthForm.vue'
import CartView from './components/CartView.vue'
import CheckoutView from './components/CheckoutView.vue'
import OrdersView from './components/OrdersView.vue'
import RequestError from './components/RequestError.vue'
const view = ref('catalog')
const user = ref(null)
const busy = ref(false)
const error = ref(null)
const notice = ref('')
let pendingProduct = null
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
  pendingProduct = null
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
    if (['login', 'register'].includes(view.value) || (view.value === 'admin' && profile.role !== 'admin')) {
      pendingProduct = null
      view.value = 'catalog'
    }
    user.value = profile
  } catch (failure) {
    if (revision !== sessionRevision || busy.value) return
    if (failure.status === 401) {
      if (user.value) clearSession()
    } else {
      restoreError.value = failure
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
  if (busy.value || (restoring.value && !user.value)) return
  if (['cart', 'checkout', 'orders', 'admin'].includes(target) && !user.value) target = 'login'
  if (target === 'admin' && user.value?.role !== 'admin') target = 'catalog'
  view.value = target; error.value = null; notice.value = ''
}
async function authenticated(profile) {
  sessionRevision++
  restoreError.value = null
  api.reset()
  user.value = profile; view.value = 'catalog'; error.value = null; notice.value = 'Вы вошли в аккаунт.'
  if (pendingProduct !== null) {
    const id = pendingProduct; pendingProduct = null
    await addProduct(id)
  }
}
async function addProduct(id) {
  if (busy.value || (restoring.value && !user.value)) return
  if (!user.value) { pendingProduct = id; navigate('login'); return }
  busy.value = true; error.value = null; notice.value = ''
  try {
    resource(await api.request('/cart/items', { method: 'POST', body: { product_id: id, quantity: 1 } }))
    notice.value = 'Товар добавлен в корзину.'
  } catch (failure) { error.value = failure }
  finally { busy.value = false }
}
async function logout() {
  if (busy.value) return
  busy.value = true; error.value = null
  try {
    await api.request('/logout', { method: 'POST' })
    clearSession()
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
      <div class="shop-nav" aria-label="Разделы магазина">
        <button class="secondary" :disabled="busy" @click="navigate('catalog')">Каталог</button>
        <template v-if="user">
          <button class="secondary" :disabled="busy" @click="navigate('cart')">Корзина</button>
          <button class="secondary" :disabled="busy" @click="navigate('orders')">Мои заказы</button>
          <button v-if="user.role === 'admin'" class="secondary" :disabled="busy" @click="navigate('admin')">Заказы магазина</button>
          <span>{{ user.name }}</span><button :disabled="busy" @click="logout">Выйти</button>
        </template>
        <template v-else-if="!restoring && !restoreError">
          <button class="secondary" :disabled="busy" @click="navigate('login')">Вход</button>
          <button :disabled="busy" @click="navigate('register')">Регистрация</button>
        </template>
      </div>
    </div>
    <div class="feedback">
      <p v-if="restoring" role="status">Проверяем сессию…</p>
      <RequestError :error="restoreError" />
      <button v-if="restoreError" :disabled="busy" @click="restoreSession">Повторить проверку сессии</button>
      <RequestError :error="error" />
      <p v-if="notice" class="notice" role="status">{{ notice }}</p>
      <p v-if="busy" role="status">Выполняем запрос…</p>
    </div>
    <Catalog v-if="view === 'catalog'" :busy="busy || (restoring && !user)" :signed-in="!!user" @add="addProduct" />
    <main v-else>
      <AuthForm v-if="view === 'login' || view === 'register'" :key="view" :register="view === 'register'" @authenticated="authenticated" @busy="busy = $event" />
      <CartView v-else-if="view === 'cart' && user" @checkout="navigate('checkout')" />
      <CheckoutView v-else-if="view === 'checkout' && user" @ordered="ordered" @history="navigate('orders')" />
      <OrdersView v-else-if="view === 'orders' && user" key="buyer-orders" />
      <OrdersView v-else-if="view === 'admin' && user?.role === 'admin'" key="admin-orders" admin />
    </main>
  </div>
</template>
