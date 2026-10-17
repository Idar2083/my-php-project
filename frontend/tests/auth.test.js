import { afterEach, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import AuthForm from '../src/components/AuthForm.vue'
import { ApiError } from '../src/api/client.js'
let wrapper
afterEach(() => wrapper?.unmount())
function render(register, api) { wrapper = mount(AuthForm, { props: { register }, global: { provide: { api } } }) }

it('validates registration password complexity before a request', async () => {
  const request = vi.fn()
  render(true, { request })
  await wrapper.get('[name=password]').setValue('short')
  await wrapper.get('form').trigger('submit')
  expect(request).not.toHaveBeenCalled()
  expect(wrapper.get('[role=alert]').text()).toContain('минимум 8 символов')
})

it('registers using exactly name/email/password and verifies the current user', async () => {
  const user = { id: 3, name: 'Buyer', role: 'user' }
  const request = vi.fn().mockResolvedValueOnce({ token: 'test-jwt' }).mockResolvedValueOnce(user)
  const setToken = vi.fn()
  render(true, { request, setToken })
  await wrapper.get('[name=name]').setValue('Buyer')
  await wrapper.get('[name=email]').setValue('buyer@example.test')
  await wrapper.get('[name=password]').setValue('StrongPassword!123')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(request).toHaveBeenNthCalledWith(1, '/register', { method: 'POST', authenticated: false, body: { name: 'Buyer', email: 'buyer@example.test', password: 'StrongPassword!123' } })
  expect(request).toHaveBeenNthCalledWith(2, '/me')
  expect(wrapper.emitted('authenticated')[0][0]).toEqual(user)
  expect(wrapper.get('[name=password]').element.value).toBe('')
})

it.each([401, 422, 429, 500])('shows a safe login error %s and clears the password', async status => {
  const request = vi.fn().mockRejectedValue(new ApiError(status, status === 422 ? ['Email уже занят.'] : []))
  render(false, { request })
  await wrapper.get('[name=password]').setValue('StrongPassword!123')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  expect(wrapper.find('[role=alert]').exists()).toBe(true)
  expect(wrapper.emitted('authenticated')).toBeUndefined()
  expect(wrapper.get('[name=password]').element.value).toBe('')
})

it('keeps duplicate sign-in submissions blocked until /me finishes and clears an unverified token', async () => {
  let reject
  const request = vi.fn().mockResolvedValueOnce({ token: 'test-jwt' }).mockImplementationOnce(() => new Promise((resolve, fail) => { reject = fail }))
  const setToken = vi.fn()
  render(false, { request, setToken })
  await wrapper.get('form').trigger('submit'); await flushPromises()
  await wrapper.get('form').trigger('submit')
  expect(request).toHaveBeenCalledTimes(2)
  expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
  reject(new ApiError(401)); await flushPromises()
  expect(setToken).toHaveBeenLastCalledWith(null)
  expect(wrapper.emitted('authenticated')).toBeUndefined()
})
