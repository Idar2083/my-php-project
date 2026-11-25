<script setup>
import { onMounted, onUnmounted, reactive, ref } from 'vue'
import { fetchProducts } from '../api/products.js'

import QuantityStepper from './QuantityStepper.vue'
import RequestError from './RequestError.vue'
import { formatAmount } from '../presentation.js'

defineProps({ busy: Boolean, items: Array, feedback: Object })
const emit = defineEmits(['add', 'cart'])
const quantities = reactive({})
const categories = { pizza: 'Пицца', drink: 'Напиток' }

function add(product) {
  emit('add', product, quantities[product.id] || 1)
}

const status = ref('loading')
const products = ref([])
const meta = ref(null)
const requestedPage = ref(1)
let controller
let timer

async function load(page = requestedPage.value) {
  controller?.abort()
  clearTimeout(timer)
  const request = new AbortController()
  controller = request
  requestedPage.value = page
  status.value = 'loading'
  timer = setTimeout(() => request.abort(), 10000)

  try {
    let result = await fetchProducts(page, request.signal)
    if (controller !== request || request.signal.aborted) return
    if (result.meta.current_page !== page) throw new Error('Некорректная страница каталога')

    // Recover once when products were removed; never loop on a changing catalog.
    if (result.meta.total > 0 && result.meta.current_page > result.meta.last_page) {
      requestedPage.value = result.meta.last_page
      result = await fetchProducts(requestedPage.value, request.signal)
      if (controller !== request || request.signal.aborted) return
      if (result.meta.current_page !== requestedPage.value ||
        (result.meta.total > 0 && result.meta.current_page > result.meta.last_page)) {
        throw new Error('Некорректная страница каталога')
      }
    }
    products.value = result.products
    meta.value = result.meta
    status.value = products.value.length ? 'success' : 'empty'
  } catch {
    if (controller === request) status.value = 'error'
  } finally {
    if (controller === request) clearTimeout(timer)
  }
}

onMounted(() => load())
onUnmounted(() => {
  controller?.abort()
  controller = null
  clearTimeout(timer)
})
</script>

<template>
  <section :aria-busy="status === 'loading'">
    <header>
      <h1 tabindex="-1">Каталог товаров</h1>
    </header>

    <section v-if="status === 'loading' && !products.length" class="state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <h2>Загружаем товары…</h2>
    </section>
    <p v-if="status === 'loading' && products.length" role="status">Загружаем товары…</p>
    <section v-if="status === 'error'" class="state" role="alert">
      <h2>Не удалось загрузить товары</h2>
      <p>Проверьте соединение и попробуйте ещё раз.</p>
      <button @click="load()">Повторить загрузку</button>
    </section>
    <section v-if="status === 'empty'" class="state" role="status">
      <h2>Товаров пока нет</h2>
      <p>Загляните позже — каталог будет пополняться.</p>
    </section>
    <section v-if="products.length" aria-label="Товары">
      <p class="count">Всего товаров: {{ meta.total }}</p>
      <ul class="products">
        <li v-for="product in products" :key="product.id" :data-product-id="product.id">
          <article>
            <p v-if="categories[product.category.trim().toLowerCase()]" class="category">{{ categories[product.category.trim().toLowerCase()] }}</p>
            <h2>{{ product.name }}</h2>
            <p v-if="product.description && product.description.length <= 160" class="description">{{ product.description }}</p>
            <details v-else-if="product.description" class="product-details">
              <summary>Описание товара</summary><p class="description">{{ product.description }}</p>
            </details>
            <div class="product-purchase">
              <p class="price">{{ formatAmount(product.price) }}</p>
              <p v-if="product.weight" class="muted">Вес: {{ product.weight }}</p>
              <QuantityStepper :name="product.name" :quantity="quantities[product.id] || 1" :disabled="busy"
                @adjust="quantities[product.id] = (quantities[product.id] || 1) + $event" />
              <button class="product-add" :disabled="busy" @click="add(product)">{{ feedback?.id === product.id && feedback.pending ? 'Добавляем…' : 'В корзину' }}</button>
              <p v-if="items?.some(item => item.product.id === product.id)" class="muted">
                В корзине: {{ items.find(item => item.product.id === product.id).quantity }}
              </p>
              <template v-if="feedback?.id === product.id">
                <RequestError :error="feedback.error" />
                <p v-if="feedback.added" class="added" role="status">Товар добавлен.</p>
                <button v-if="feedback.added" class="text-button" @click="$emit('cart')">Перейти в корзину</button>
              </template>
            </div>
          </article>
        </li>
      </ul>
    </section>

    <nav v-if="meta?.last_page > 1"
      class="pagination" aria-label="Страницы каталога">
      <button :disabled="status === 'loading' || meta.current_page <= 1" @click="load(meta.current_page - 1)">Назад</button>
      <span>Страница {{ meta.current_page }} из {{ meta.last_page }}</span>
      <button :disabled="status === 'loading' || meta.current_page >= meta.last_page" @click="load(meta.current_page + 1)">Далее</button>
    </nav>
  </section>
</template>
