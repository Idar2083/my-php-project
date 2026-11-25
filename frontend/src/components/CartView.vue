<script setup>
import { computed } from 'vue'
import RequestError from './RequestError.vue'
import QuantityStepper from './QuantityStepper.vue'
import { formatAmount, totalAmount } from '../presentation.js'

const props = defineProps({
  items: Array, guestItems: Array, busy: Boolean, loading: Boolean, pending: Object, paused: Set,
  error: Error, errors: Object, importError: Error, guestErrors: Object,
})
defineEmits(['checkout', 'catalog', 'adjust', 'remove', 'retry', 'retry-row', 'import', 'guest-adjust', 'guest-remove'])
const total = computed(() => totalAmount(props.items))
</script>

<template>
  <section>
    <h1 tabindex="-1">Корзина</h1>
    <RequestError :error="error" />
    <button v-if="error" class="secondary" :disabled="busy || loading" @click="$emit('retry')">Обновить корзину</button>
    <p v-if="loading" role="status">Обновляем корзину…</p>
    <div v-if="items && !items.length" class="panel">
      <p>Корзина пуста. Выберите пиццу или напиток в каталоге.</p>
      <button class="secondary" @click="$emit('catalog')">Перейти в каталог</button>
    </div>
    <div v-else-if="items?.length" class="cart-layout">
      <ul class="item-list">
        <li v-for="item in items" :key="item.id" class="panel cart-item">
          <div><h2>{{ item.product.name }}</h2><p>За штуку: {{ formatAmount(item.product.price) }}</p></div>
          <div class="cart-controls">
            <QuantityStepper :quantity="paused?.has(String(item.id)) ? item.quantity : (pending?.[item.id]?.quantity ?? item.quantity)" :name="item.product.name"
              :disabled="busy || paused?.has(String(item.id)) || pending?.[item.id]?.remove" @adjust="$emit('adjust', item, $event)" />
            <strong>{{ formatAmount(totalAmount([item])) }}</strong>
            <button class="text-button" :disabled="busy || pending?.[item.id]?.remove"
              :aria-label="`Удалить: ${item.product.name}`" @click="$emit('remove', item)">Удалить</button>
          </div>
          <p v-if="pending?.[item.id] && !paused?.has(String(item.id))" class="muted" role="status">Сохраняем изменение…</p>
          <RequestError :error="errors?.[item.id]" />
          <button v-if="paused?.has(String(item.id))" class="secondary" :disabled="busy"
            @click="$emit('retry-row', item.id)">Сверить и повторить изменение</button>
        </li>
      </ul>
      <aside class="panel cart-total">
        <h2>Итого</h2>
        <p class="total">{{ formatAmount(total) }}</p>
        <p class="muted">Окончательную стоимость рассчитает сервер при оформлении.</p>
        <p v-if="guestItems?.length" class="muted">Гостевые товары останутся в браузере, если оформить только товары аккаунта.</p>
        <button :disabled="busy || loading || !!error" @click="$emit('checkout')">Оформить заказ</button>
      </aside>
    </div>
    <section v-if="guestItems?.length" class="panel guest-transfer">
      <h2>Товары из гостевой корзины</h2>
      <p>Гостевые позиции ожидают переноса. При превышении лимита уменьшите количество в корзине аккаунта или измените гостевые позиции.</p>
      <RequestError :error="importError" />
      <ul class="item-list">
        <li v-for="item in guestItems" :key="item.id" class="cart-item">
          <strong>{{ item.product.name }}</strong>
          <div class="cart-controls">
            <QuantityStepper :quantity="item.quantity" :name="item.product.name" :disabled="busy"
              @adjust="$emit('guest-adjust', item, $event)" />
            <button class="text-button" :disabled="busy" @click="$emit('guest-remove', item)">Удалить</button>
          </div>
          <RequestError :error="guestErrors?.[item.id]" />
        </li>
      </ul>
      <button :disabled="busy || loading" @click="$emit('import')">{{ busy ? 'Переносим…' : 'Повторить перенос' }}</button>
    </section>
  </section>
</template>
