<script setup>
import { inject, onMounted, ref } from 'vue'
import { resource } from '../api/client.js'
import OrderDetails from './OrderDetails.vue'
import RequestError from './RequestError.vue'
const props = defineProps({ admin: Boolean })
const api = inject('api')
const orders = ref(null)
const meta = ref(null)
const detail = ref(null)
const detailId = ref(null)
const selectedStatus = ref('')
const error = ref(null)
const notice = ref('')
const busy = ref(false)
const page = ref(1)
const statuses = { created: 'Создан', paid: 'Оплачен', in_process: 'Готовится', delivering: 'Доставляется', completed: 'Завершён', cancelled: 'Отменён' }
const base = props.admin ? '/admin/orders' : '/orders'
async function load(target = page.value) {
  if (busy.value) return
  busy.value = true; error.value = null
  page.value = target; detail.value = null; detailId.value = null
  try {
    const result = await api.request(`${base}?page=${target}`)
    if (!Array.isArray(result?.data)) throw new Error('Некорректный ответ списка заказов.')
    orders.value = result.data; meta.value = result.meta || null
  } catch (failure) { orders.value = null; error.value = failure }
  finally { busy.value = false }
}
async function open(id) {
  if (busy.value) return
  busy.value = true; error.value = null; notice.value = ''; detail.value = null; detailId.value = id
  try {
    detail.value = resource(await api.request(`${base}/${id}`))
    selectedStatus.value = detail.value.allowed_statuses?.[0] || ''
  } catch (failure) {
    error.value = failure
    if (failure.status === 403) orders.value = null
  } finally { busy.value = false }
}
async function updateStatus() {
  if (busy.value || !detail.value?.allowed_statuses?.includes(selectedStatus.value)) return
  busy.value = true; error.value = null; notice.value = ''
  try {
    const updated = resource(await api.request(`/orders/${detail.value.id}/status`, { method: 'PUT', body: { status: selectedStatus.value } }))
    notice.value = 'Статус обновлён.'
    const index = orders.value.findIndex(order => order.id === updated.id)
    if (index >= 0) orders.value[index] = { ...orders.value[index], ...updated }
    detail.value = null
    detail.value = resource(await api.request(`${base}/${updated.id}`))
    selectedStatus.value = detail.value.allowed_statuses?.[0] || ''
  } catch (failure) { error.value = failure; detail.value = null }
  finally { busy.value = false }
}
onMounted(() => load())
</script>
<template>
  <section :aria-busy="busy">
    <h1>{{ admin ? 'Заказы магазина' : 'Мои заказы' }}</h1>
    <p v-if="admin" class="muted">Статус «Оплачен» — ручная отметка администратора. Онлайн-платежи не подключены.</p>
    <RequestError :error="error" />
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="busy" role="status">Загружаем данные…</p>
    <div class="actions"><button class="secondary" :disabled="busy" @click="load()">Обновить список</button><button v-if="detailId && error" :disabled="busy" @click="open(detailId)">Повторить загрузку заказа</button></div>
    <p v-if="orders && !orders.length" class="state">Заказов пока нет.</p>
    <ul v-if="orders?.length" class="item-list">
      <li v-for="order in orders" :key="order.id" class="panel order-row">
        <div><strong>№{{ order.id }}</strong> · {{ statuses[order.status] || order.status }} · {{ order.total_price }}<p v-if="admin && order.customer">{{ order.customer.name }} · {{ order.customer.email }}</p></div>
        <button :disabled="busy" @click="open(order.id)">Подробнее о заказе №{{ order.id }}</button>
      </li>
    </ul>
    <nav v-if="meta?.last_page > 1" class="pagination" aria-label="Страницы заказов">
      <button :disabled="busy || page <= 1" @click="load(page - 1)">Назад</button><span>{{ page }} из {{ meta.last_page }}</span><button :disabled="busy || page >= meta.last_page" @click="load(page + 1)">Далее</button>
    </nav>
    <OrderDetails v-if="detail" :order="detail">
      <form v-if="admin && detail.allowed_statuses?.length" @submit.prevent="updateStatus">
        <label>Новый статус<select v-model="selectedStatus" name="status" :disabled="busy"><option v-for="status in detail.allowed_statuses" :key="status" :value="status">{{ statuses[status] || status }}</option></select></label>
        <button :disabled="busy">Изменить статус</button>
      </form>
      <p v-else-if="admin">Заказ закрыт. Изменение статуса недоступно.</p>
    </OrderDetails>
  </section>
</template>
