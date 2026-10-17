<script setup>
import { inject, onBeforeUnmount, reactive, ref } from 'vue'
import RequestError from './RequestError.vue'
const props = defineProps({ register: Boolean })
const emit = defineEmits(['authenticated', 'busy'])
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
    const result = await api.request(props.register ? '/register' : '/login', { method: 'POST', body, authenticated: false })
    if (!active) return
    if (typeof result?.token !== 'string' || !result.token) throw new Error('Не удалось открыть сессию.')
    fields.password = ''
    api.setToken(result.token)
    try {
      const user = await api.request('/me')
      if (!user?.id || !['user', 'admin'].includes(user.role)) throw new Error('Не удалось проверить сессию.')
      if (!active) { api.setToken(null); return }
      profile = user
    } catch (failure) { api.setToken(null); throw failure }
  } catch (failure) { error.value = failure }
  finally { fields.password = ''; busy.value = false; emit('busy', false) }
  if (active && profile) emit('authenticated', profile)
}
</script>
<template>
  <section class="panel narrow">
    <h1>{{ register ? 'Регистрация' : 'Вход' }}</h1>
    <p>Корзина и заказы доступны после входа. После перезагрузки страницы нужно войти снова.</p>
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
  </section>
</template>
