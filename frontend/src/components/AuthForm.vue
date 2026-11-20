<script setup>
import { inject, onBeforeUnmount, reactive, ref } from 'vue'
import RequestError from './RequestError.vue'
const props = defineProps({ register: Boolean, checkout: Boolean })
const emit = defineEmits(['authenticated', 'busy', 'switch'])
const api = inject('api')
const fields = reactive({ name: '', email: '', password: '' })
let active = true
onBeforeUnmount(() => { active = false })
const busy = ref(false)
const error = ref(null)
async function submit() {
  if (busy.value) return
  error.value = null
  if (props.register && !/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[^a-zA-Z0-9]).{8,}$/s.test(fields.password)) {
    error.value = { message: 'Пароль: минимум 8 символов, заглавная и строчная буквы, цифра и спецсимвол.' }
    return
  }
  busy.value = true
  emit('busy', true)
  let profile = null
  try {
    const body = { email: fields.email, password: fields.password }
    if (props.register) body.name = fields.name
    const user = await api.request(props.register ? '/register' : '/login', { method: 'POST', body, authenticated: false })
    if (!user?.id || !['user', 'admin'].includes(user.role)) throw new Error('Не удалось проверить сессию.')
    profile = user
  } catch (failure) { error.value = failure }
  finally { fields.password = ''; busy.value = false; emit('busy', false) }
  if (active && profile) emit('authenticated', profile)
}
</script>
<template>
  <section class="panel narrow">
    <h1>{{ register ? 'Регистрация' : 'Вход' }}</h1>
    <p v-if="checkout" role="status">Войдите или зарегистрируйтесь, чтобы оформить заказ. Товары останутся в корзине.</p>
    <RequestError :error="error" />
    <form @submit.prevent="submit" :aria-busy="busy">
      <fieldset :disabled="busy">
        <label v-if="register">Имя<input v-model="fields.name" name="name" autocomplete="name" required maxlength="255"></label>
        <label>Email<input v-model="fields.email" name="email" type="email" autocomplete="username" required maxlength="255"></label>
        <label>Пароль<input v-model="fields.password" name="password" type="password" :autocomplete="register ? 'new-password' : 'current-password'" required :minlength="register ? 8 : 1" maxlength="4096"></label>
        <p v-if="register" class="muted">От 8 символов, заглавная и строчная буквы, цифра и спецсимвол.</p>
        <button type="submit">{{ busy ? 'Подождите…' : register ? 'Создать аккаунт' : 'Войти' }}</button>
      </fieldset>
    </form>
    <button type="button" class="secondary auth-switch" :disabled="busy" @click="emit('switch')">
      {{ register ? 'Уже есть аккаунт? Войти' : 'Зарегистрироваться' }}
    </button>
  </section>
</template>
