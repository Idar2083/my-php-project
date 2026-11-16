<script setup>
defineProps({ order: { type: Object, required: true } })
const statuses = { created: 'Создан', paid: 'Оплачен', in_process: 'Готовится', delivering: 'Доставляется', completed: 'Завершён', cancelled: 'Отменён' }
const methods = { delivery: 'Доставка', pickup: 'Самовывоз', courier: 'Курьер' }
</script>
<template>
  <article class="panel order-detail">
    <h2>Заказ №{{ order.id }}</h2>
    <p>Статус: <strong>{{ statuses[order.status] || order.status }}</strong></p>
    <p v-if="order.customer">Покупатель: {{ order.customer.name }} · {{ order.customer.email }} · ID {{ order.customer.id }}</p>
    <p v-if="order.created_at">Создан: {{ new Date(order.created_at).toLocaleString('ru-RU') }}</p>
    <p>Получение: {{ methods[order.delivery_method] || order.delivery_method }}</p>
    <p v-if="order.address">Адрес: {{ [order.address.region, order.address.city, order.address.street, order.address.house, order.address.apartment && `кв. ${order.address.apartment}`, order.address.entrance && `подъезд ${order.address.entrance}`, order.address.postal_code].filter(Boolean).join(', ') }}</p>
    <ul><li v-for="item in order.items" :key="item.id">{{ item.product_name || item.product?.name || `Товар №${item.product_id}` }} — {{ item.quantity }} × {{ item.price }}</li></ul>
    <p class="total">Итого по заказу: {{ order.total_price }}</p>
    <slot />
  </article>
</template>
