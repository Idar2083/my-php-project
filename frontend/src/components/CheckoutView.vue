<script setup>
import { inject, reactive, ref } from 'vue'
import { resource } from '../api/client.js'
import RequestError from './RequestError.vue'
const emit = defineEmits(['ordered', 'history'])
const api = inject('api')
const address = reactive({ delivery_method: 'delivery', region: '', city: '', street: '', house: '', apartment: '', entrance: '', postal_code: '' })
const labels = { region: 'Регион', city: 'Город', street: 'Улица', house: 'Дом', apartment: 'Квартира (необязательно)', entrance: 'Подъезд (необязательно)', postal_code: 'Почтовый индекс' }
const busy = ref(false)
const error = ref(null)
async function submit() {
  if (busy.value) return
  busy.value = true; error.value = null
  try {
    const order = resource(await api.request('/orders', { method: 'POST', body: { ...address } }))
    if (!order.id) throw new Error('Не удалось подтвердить заказ. Проверьте историю заказов.')
    emit('ordered', order)
  } catch (failure) { error.value = failure }
  finally { busy.value = false }
}
</script>
<template>
  <section class="panel narrow">
    <h1>Оформление заказа</h1>
    <p>Итоговую сумму и состав заказа определяет сервер по вашей корзине. Онлайн-оплата пока недоступна.</p>
    <RequestError :error="error" />
    <p v-if="error" class="notice">Если ответ потерялся, сначала проверьте историю: заказ мог быть создан. <button class="secondary" @click="emit('history')">История заказов</button></p>
    <form @submit.prevent="submit" :aria-busy="busy">
      <fieldset :disabled="busy">
        <label>Способ получения<select v-model="address.delivery_method" name="delivery_method"><option value="delivery">Доставка</option><option value="pickup">Самовывоз</option><option value="courier">Курьер</option></select></label>
        <p class="muted">API требует адрес для всех способов получения, включая самовывоз.</p>
        <label v-for="(label, field) in labels" :key="field">{{ label }}<input v-model="address[field]" :name="field" :required="!['apartment', 'entrance'].includes(field)" maxlength="255" :autocomplete="field === 'postal_code' ? 'postal-code' : 'off'"></label>
        <button type="submit">{{ busy ? 'Отправляем заказ…' : 'Подтвердить заказ' }}</button>
      </fieldset>
    </form>
  </section>
</template>
