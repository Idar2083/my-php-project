<script setup>
import { inject, onBeforeUnmount, reactive, ref } from 'vue'
import RequestError from './RequestError.vue'
const props = defineProps({ register: Boolean, checkout: Boolean })
const emit = defineEmits(['authenticated', 'busy', 'switch'])
const api = inject('api')
const email = defineModel('email', { type: String, default: '' })
const fields = reactive({ name: '', password: '' })
let active = true
onBeforeUnmount(() => { active = false })
const busy = ref(false)
const error = ref(null)
async function submit() {
  if (busy.value) return
  error.value = null
  busy.value = true
  emit('busy', true)
  let profile = null
  try {
    const body = { email: email.value, password: fields.password }
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
    <h1 tabindex="-1">{{ register ? 'Регистрация' : 'Вход' }}</h1>
    <p v-if="checkout" role="status">Войдите или зарегистрируйтесь, чтобы оформить заказ. Товары останутся в корзине.</p>
    <RequestError :error="error" />
    <form @submit.prevent="submit" :aria-busy="busy">
      <fieldset :disabled="busy">
        <label v-if="register">Имя<input v-model="fields.name" name="name" :aria-invalid="!!error?.fields?.name" :aria-describedby="error?.fields?.name ? 'auth-name' : undefined" autocomplete="name" required maxlength="255"></label>
        <p v-if="error?.fields?.name" id="auth-name" class="field-error">{{ error.fields.name.join(' ') }}</p>
        <label>Email<input v-model="email" name="email" :aria-invalid="!!error?.fields?.email" :aria-describedby="error?.fields?.email ? 'auth-email' : undefined" type="email" autocomplete="username" required maxlength="255"></label>
        <p v-if="error?.fields?.email" id="auth-email" class="field-error">{{ error.fields.email.join(' ') }}</p>
        <label>Пароль<input v-model="fields.password" name="password" :aria-invalid="!!error?.fields?.password" :aria-describedby="error?.fields?.password ? 'auth-password' : undefined" type="password" :autocomplete="register ? 'new-password' : 'current-password'" required :minlength="register ? 8 : 1" maxlength="4096"></label>
        <p v-if="error?.fields?.password" id="auth-password" class="field-error">{{ error.fields.password.join(' ') }}</p>
        <p v-if="register" class="muted">От 8 символов, заглавная и строчная буквы, цифра и спецсимвол.</p>
        <button type="submit">{{ busy ? 'Подождите…' : register ? 'Создать аккаунт' : 'Войти' }}</button>
      </fieldset>
    </form>
    <button type="button" class="secondary auth-switch" :disabled="busy" @click="emit('switch')">
      {{ register ? 'Уже есть аккаунт? Войти' : 'Зарегистрироваться' }}
    </button>
  </section>
</template>
