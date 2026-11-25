<script setup>
import { ref, watch } from 'vue'

const props = defineProps({ user: Object, count: Number, busy: Boolean, restoring: Boolean, view: String })
const emit = defineEmits(['navigate', 'logout'])
const open = ref(false)
const trigger = ref(null)

function close(restoreFocus = false) {
  if (!open.value) return
  open.value = false
  if (restoreFocus) trigger.value?.focus()
}

function navigate(target) {
  close()
  emit('navigate', target)
}

watch(() => props.user?.id, () => close())
</script>

<template>
  <header class="shop-header">
    <div class="shop-bar">
      <a href="#catalog" class="brand" @click.prevent="!busy && navigate('catalog')">Pizza &amp; drinks</a>
      <nav class="shop-nav" aria-label="Разделы магазина">
        <button class="header-action" :aria-current="view === 'catalog' ? 'page' : undefined"
          :disabled="busy" @click="navigate('catalog')">Каталог</button>
        <button class="header-action cart-link" :aria-current="view === 'cart' ? 'page' : undefined"
          :disabled="busy" @click="navigate('cart')">Корзина{{ count == null ? '' : ` (${count})` }}</button>
      </nav>
      <div v-if="user" class="shop-account" @keydown.esc.stop="close(true)" @focusout="event => { if (!event.currentTarget.contains(event.relatedTarget)) close() }">
        <button ref="trigger" class="header-action account-name" type="button" :aria-expanded="open"
          aria-controls="shop-account-actions" :title="user.name" :disabled="busy" @click="open = !open">{{ user.name }}</button>
        <div v-show="open" id="shop-account-actions" class="account-actions panel">
          <button class="secondary" @click="navigate('account')">Личный кабинет</button>
          <button class="secondary" @click="navigate('orders')">Мои заказы</button>
          <button v-if="user.role === 'admin'" class="secondary" @click="navigate('admin')">Заказы магазина</button>
          <button :disabled="busy" @click="close(true); $emit('logout')">Выйти</button>
        </div>
      </div>
      <div v-else-if="!restoring" class="guest-actions">
        <button class="header-action" :disabled="busy" @click="navigate('login')">Войти</button>
        <button class="header-action" :disabled="busy" @click="navigate('register')">Регистрация</button>
      </div>
    </div>
  </header>
</template>
