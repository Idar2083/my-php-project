<script setup>
import { inject, nextTick, onMounted, ref } from 'vue'
import { resource } from '../api/client.js'
import OrderDetails from './OrderDetails.vue'
import RequestError from './RequestError.vue'
import { formatAmount, orderStatuses as statuses } from '../presentation.js'
const props = defineProps({ admin: Boolean, reviewOrder: Boolean })
defineEmits(['confirm-order'])
const api = inject('api')
const orders = ref(null)
const meta = ref(null)
const detail = ref(null)
const detailId = ref(null)
const selectedStatus = ref('')
const listError = ref(null)
const detailError = ref(null)
const statusError = ref(null)
const activity = ref('')
const detailHeading = ref(null)
const notice = ref('')
const busy = ref(false)
const page = ref(1)
const base = props.admin ? '/admin/orders' : '/orders'
async function load(target = page.value) {
  if (busy.value) return
  busy.value = true
  activity.value = 'Загружаем список заказов…'
  listError.value = null
  try {
    const result = await api.request(`${base}?page=${target}`)
    if (!Array.isArray(result?.data)) throw new Error('Некорректный ответ списка заказов.')
    orders.value = result.data
    meta.value = result.meta || null
    page.value = target
    detail.value = detailId.value = detailError.value = statusError.value = null
    notice.value = ''
  } catch (failure) {
    listError.value = failure
    if (failure.status === 403) orders.value = meta.value = detail.value = null
  } finally { busy.value = false }
}

async function loadDetail(id) {
  detail.value = resource(await api.request(`${base}/${id}`))
  selectedStatus.value = detail.value.allowed_statuses?.[0] || ''
}

async function open(id) {
  if (busy.value) return
  busy.value = true
  activity.value = 'Загружаем заказ…'
  detailError.value = statusError.value = null
  if (detailId.value !== id) {
    notice.value = ''
    detail.value = null
  }
  detailId.value = id
  try {
    await loadDetail(id)
    await nextTick()
    detailHeading.value?.querySelector('h2')?.focus()
  } catch (failure) {
    detailError.value = failure
    if (failure.status === 403) orders.value = meta.value = detail.value = null
  } finally { busy.value = false }
}

async function updateStatus() {
  if (busy.value || detailError.value || !detail.value?.allowed_statuses?.includes(selectedStatus.value)) return
  busy.value = true
  activity.value = 'Сохраняем статус…'
  statusError.value = null
  notice.value = ''
  const id = detail.value.id
  try {
    const updated = resource(await api.request(`/orders/${id}/status`, { method: 'PUT', body: { status: selectedStatus.value } }))
    const index = orders.value?.findIndex(order => order.id === id) ?? -1
    if (index >= 0) orders.value[index] = { ...orders.value[index], ...updated }
    detail.value = { ...detail.value, ...updated, allowed_statuses: [] }
    try {
      await loadDetail(id)
      notice.value = 'Статус обновлён.'
    } catch {
      detailError.value = new Error('Статус сохранён. Повторите загрузку деталей.')
    }
  } catch (failure) {
    statusError.value = failure
    if (!failure.status || failure.status >= 500 || failure.status === 409) {
      detailError.value = new Error('Обновите заказ перед повтором изменения статуса.')
    }
  } finally { busy.value = false }
}
onMounted(() => load())
</script>
<template>
  <section :aria-busy="busy">
    <h1 tabindex="-1">{{ admin ? 'Заказы магазина' : 'Мои заказы' }}</h1>
    <p v-if="admin" class="muted">Статус «Оплачен» — ручная отметка администратора. Онлайн-платежи не подключены.</p>
    <p v-if="reviewOrder" class="notice warning">
      Результат отправки неизвестен. Откройте заказ и сравните его состав, адрес и время с вашей отправкой.
      Если заказ не найден, обратитесь в магазин перед повторной отправкой.
    </p>
    <RequestError :error="listError" />
    <RequestError :error="statusError" />
    <RequestError :error="detailError" />
    <p v-if="notice" class="notice" role="status">{{ notice }}</p>
    <p v-if="busy" role="status">{{ activity }}</p>
    <div class="actions"><button class="secondary" :disabled="busy" @click="load()">Обновить список</button><button v-if="detailId && detailError" :disabled="busy" @click="open(detailId)">Повторить загрузку заказа</button></div>
    <p v-if="orders && !orders.length" class="state">Заказов пока нет.</p>
    <ul v-if="orders?.length" class="item-list">
      <li v-for="order in orders" :key="order.id" class="panel order-row">
        <div><strong>№{{ order.id }}</strong> · {{ statuses[order.status] || order.status }} · {{ formatAmount(order.total_price) }}<p v-if="admin && order.customer">{{ order.customer.name }} · {{ order.customer.email }}</p></div>
        <button :disabled="busy" @click="open(order.id)">Подробнее о заказе №{{ order.id }}</button>
      </li>
    </ul>
    <nav v-if="meta?.last_page > 1" class="pagination" aria-label="Страницы заказов">
      <button :disabled="busy || page <= 1" @click="load(page - 1)">Назад</button><span>{{ page }} из {{ meta.last_page }}</span><button :disabled="busy || page >= meta.last_page" @click="load(page + 1)">Далее</button>
    </nav>
    <div v-if="detail" ref="detailHeading">
    <OrderDetails :order="detail">
      <button v-if="reviewOrder && !detailError" :disabled="busy"
        @click="$emit('confirm-order', detail)">Подтвердить заказ из этой отправки</button>
      <form v-if="admin && !detailError && detail.allowed_statuses?.length" @submit.prevent="updateStatus">
        <label>Новый статус<select v-model="selectedStatus" name="status" :disabled="busy"><option v-for="status in detail.allowed_statuses" :key="status" :value="status">{{ statuses[status] || status }}</option></select></label>
        <p v-if="['completed', 'cancelled'].includes(selectedStatus)" class="muted">
          После подтверждения заказ №{{ detail.id }} будет закрыт.
        </p>
        <button :disabled="busy">{{ selectedStatus === 'completed' ? 'Подтвердить завершение' :
          selectedStatus === 'cancelled' ? 'Подтвердить отмену' : 'Изменить статус' }}</button>
      </form>
      <p v-else-if="admin && !detailError">Заказ закрыт. Изменение статуса недоступно.</p>
    </OrderDetails>
    </div>
  </section>
</template>
