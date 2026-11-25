<script setup>
import RequestError from './RequestError.vue'
import { formatAmount, totalAmount } from '../presentation.js'

defineProps({ items: Array, busy: Boolean, error: Error, uncertain: Boolean })
defineEmits(['submit', 'history', 'verify', 'cart'])
const address = defineModel({ type: Object, required: true })
const fields = [
  ['region', 'Регион', 'address-level1'], ['city', 'Город', 'address-level2'],
  ['street', 'Улица', 'address-line1'], ['house', 'Дом', 'off'],
  ['apartment', 'Квартира', 'address-line2', true], ['entrance', 'Подъезд', 'off', true],
  ['postal_code', 'Почтовый индекс', 'postal-code'],
]
</script>

<template>
  <h1 tabindex="-1">Оформление заказа</h1>
  <div class="checkout-layout">
    <section class="panel">
      <RequestError :error="error" />
      <p v-if="uncertain && !error" class="notice warning" role="status">
        Результат отправки ещё не подтверждён. Проверьте историю и актуальную корзину.
      </p>
      <div v-if="uncertain" class="actions">
        <button class="secondary" @click="$emit('history')">История заказов</button>
        <button class="secondary" @click="$emit('verify')">Проверить корзину</button>
      </div>
      <button v-if="error?.fields?.cart" class="secondary" @click="$emit('cart')">Вернуться в корзину</button>
      <form @submit.prevent="$emit('submit')" :aria-busy="busy">
        <fieldset :disabled="busy">
          <label>Способ получения
            <select v-model="address.delivery_method" name="delivery_method"
              :aria-invalid="!!error?.fields?.delivery_method" :aria-describedby="error?.fields?.delivery_method ? 'checkout-delivery_method' : undefined">
              <option value="delivery">Доставка</option>
              <option value="pickup">Самовывоз</option>
              <option value="courier">Курьер</option>
            </select>
          </label>
          <p v-if="error?.fields?.delivery_method" id="checkout-delivery_method" class="field-error">{{ error.fields.delivery_method.join(' ') }}</p>
          <p class="muted">Укажите адрес для выбранного способа получения.</p>
          <div class="address-fields">
            <div v-for="[field, label, autocomplete, optional] in fields" :key="field">
              <label>{{ label }}{{ optional ? ' (необязательно)' : '' }}
                <input v-model="address[field]" :name="field" :required="!optional" maxlength="255"
                  :autocomplete="autocomplete" :aria-invalid="!!error?.fields?.[field]"
                  :aria-describedby="error?.fields?.[field] ? 'checkout-' + field : undefined">
              </label>
              <p v-if="error?.fields?.[field]" :id="'checkout-' + field" class="field-error">{{ error.fields[field].join(' ') }}</p>
            </div>
          </div>
          <button type="submit" :disabled="uncertain || !items?.length">{{ busy ? 'Отправляем заказ…' : 'Подтвердить заказ' }}</button>
        </fieldset>
      </form>
      <button class="text-button" :disabled="busy" @click="$emit('cart')">Вернуться в корзину</button>
    </section>
    <aside class="panel cart-total">
      <h2>Ваш заказ</h2>
      <ul class="summary-list"><li v-for="item in items" :key="item.id">{{ item.product.name }} × {{ item.quantity }}</li></ul>
      <p class="total">{{ formatAmount(totalAmount(items)) }}</p>
      <p class="muted">Окончательную стоимость рассчитает сервер. Онлайн-оплата недоступна.</p>
    </aside>
  </div>
</template>
