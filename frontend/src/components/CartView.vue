<script setup>
import { computed, inject, onMounted, ref } from 'vue'
import { resource } from '../api/client.js'
import RequestError from './RequestError.vue'
defineEmits(['checkout'])
const api = inject('api')
const cart = ref(null)
const error = ref(null)
const busy = ref(false)
const total = computed(() => (cart.value?.items || []).reduce((sum, item) => sum + Math.round(item.product.price * 100) * item.quantity, 0) / 100)
async function load() {
  if (busy.value) return
  busy.value = true; error.value = null
  try { cart.value = resource(await api.request('/cart')) }
  catch (failure) { error.value = failure }
  finally { busy.value = false }
}
async function mutate(item, method, quantity) {
  if (busy.value) return
  busy.value = true; error.value = null
  try {
    cart.value = resource(await api.request(`/cart/items/${item.id}`, {
      method, ...(method === 'PUT' ? { body: { quantity } } : {}),
    }))
  } catch (failure) { error.value = failure }
  finally { busy.value = false }
}
onMounted(load)
</script>
<template>
  <section :aria-busy="busy">
    <h1>Корзина</h1>
    <RequestError :error="error" />
    <button v-if="error" :disabled="busy" @click="load">Обновить корзину</button>
    <p v-if="busy" role="status">Обновляем корзину…</p>
    <p v-if="cart && !cart.items.length" class="state">Корзина пуста. Выберите пиццу или напиток в каталоге.</p>
    <template v-if="cart?.items.length">
      <ul class="item-list">
        <li v-for="item in cart.items" :key="item.id" class="panel cart-item">
          <div><h2>{{ item.product.name }}</h2><p>{{ item.product.price }} × {{ item.quantity }} = {{ (item.product.price * item.quantity).toFixed(2) }}</p></div>
          <form @submit.prevent="mutate(item, 'PUT', Number($event.target.elements.quantity.value))">
            <label>Количество<input name="quantity" type="number" :value="item.quantity" min="1" max="30" step="1" required :disabled="busy"></label>
            <button :disabled="busy">Сохранить</button>
          </form>
          <button class="secondary" :disabled="busy" @click="mutate(item, 'DELETE')">Удалить</button>
        </li>
      </ul>
      <p class="total">Итого по текущим ценам: {{ total.toFixed(2) }}</p>
      <p class="muted">Окончательную стоимость рассчитает сервер при оформлении.</p>
      <button :disabled="busy || !!error" @click="$emit('checkout')">Оформить заказ</button>
    </template>
  </section>
</template>
