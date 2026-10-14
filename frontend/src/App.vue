<script setup>
import { onMounted, onUnmounted, ref } from 'vue'
import { fetchProducts } from './api/products.js'

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
  <main :aria-busy="status === 'loading'">
    <header>
      <p class="eyebrow">Pizza & drinks</p>
      <h1>Каталог товаров</h1>
      <p class="intro">Пицца и напитки — выбирайте то, что любите.</p>
    </header>

    <section v-if="status === 'loading'" class="state" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <h2>Загружаем товары…</h2>
    </section>
    <section v-else-if="status === 'error'" class="state" role="alert">
      <h2>Не удалось загрузить товары</h2>
      <p>Проверьте соединение и попробуйте ещё раз.</p>
      <button @click="load()">Повторить загрузку</button>
    </section>
    <section v-else-if="status === 'empty'" class="state" role="status">
      <h2>Товаров пока нет</h2>
      <p>Загляните позже — каталог будет пополняться.</p>
    </section>
    <section v-else aria-label="Товары">
      <p class="count">Всего товаров: {{ meta.total }}</p>
      <ul class="products">
        <li v-for="product in products" :key="product.id">
          <article>
            <p class="category">{{ product.category }}</p>
            <h2>{{ product.name }}</h2>
            <p v-if="product.description" class="description">{{ product.description }}</p>
            <dl>
              <div><dt>Цена</dt><dd>{{ product.price }}</dd></div>
              <div><dt>Вес</dt><dd>{{ product.weight }}</dd></div>
            </dl>
          </article>
        </li>
      </ul>
    </section>

    <nav v-if="(status === 'success' || status === 'empty') && meta.last_page > 1"
      class="pagination" aria-label="Страницы каталога">
      <button :disabled="meta.current_page <= 1" @click="load(meta.current_page - 1)">Назад</button>
      <span>Страница {{ meta.current_page }} из {{ meta.last_page }}</span>
      <button :disabled="meta.current_page >= meta.last_page" @click="load(meta.current_page + 1)">Далее</button>
    </nav>
  </main>
</template>
