// Real HTTP API + Vue/jsdom integration. This is not a browser E2E test.
import { randomUUID } from 'node:crypto'
import { afterEach, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import App from '../src/App.vue'
let wrapper
afterEach(() => wrapper?.unmount())
const enabled = !!process.env.UI_API_URL && !!process.env.UI_TEST_ADMIN_PASSWORD

it.runIf(enabled)('purchases through the real API and processes the same order as an administrator', async () => {
  const origin = new URL(process.env.UI_API_URL)
  expect(origin.hostname).toBe('127.0.0.1')
  vi.stubEnv('VITE_API_BASE_URL', '/api')
  const nativeFetch = globalThis.fetch
  const cookies = new Map()
  const responses = []
  function browserHeaders() {
    return { Accept: 'application/json', Origin: origin.origin, 'X-Pizza-Client': 'spa', Cookie: [...cookies.values()].join('; ') }
  }
  vi.stubGlobal('fetch', async (url, options) => {
    const headers = options?.credentials === 'same-origin'
      ? { ...options.headers, ...browserHeaders() }
      : options?.headers
    const response = await nativeFetch(new URL(url, origin), { ...options, headers })
    responses.push(`${options?.method || 'GET'} ${new URL(url, origin).pathname} ${response.status}`)
    if (options?.credentials === 'same-origin') {
      for (const cookie of response.headers.getSetCookie()) {
        const pair = cookie.split(';', 1)[0]
        const name = pair.split('=', 1)[0]
        cookies.set(name, pair)
        if (name === 'XSRF-TOKEN') document.cookie = pair
      }
    }
    return response
  })
  wrapper = mount(App)
  const wait = async predicate => vi.waitFor(() => expect(predicate(), `${predicate}\n${responses.join('\n')}`).toBeTruthy(), { timeout: 15000, interval: 30 })
  const text = () => wrapper.text()
  async function click(label) {
    await wait(() => wrapper.findAll('button').some(button => button.text() === label && button.attributes('disabled') === undefined))
    await wrapper.findAll('button').find(button => button.text() === label).trigger('click')
  }
  await wait(() => text().includes('UI integration pizza'))
  const pizza = () => wrapper.findAll('article').find(card => card.text().includes('UI integration pizza'))
  await pizza().get('summary').trigger('click')
  expect(pizza().get('details').attributes('open')).toBeDefined()
  await pizza().get('button').trigger('click')
  await click('Корзина (1)')
  await wrapper.get('[name=quantity]').setValue(2)
  await wrapper.get('form').trigger('submit')
  await wait(() => text().includes('Итого по текущим ценам: 25.00'))
  await click('Удалить')
  await wait(() => text().includes('Корзина пуста'))
  await click('Каталог')
  await wait(() => !!pizza())
  await pizza().get('button').trigger('click')
  await click('Корзина (1)')
  await click('Оформить заказ')
  await click('Зарегистрироваться')
  const email = `ui-${randomUUID()}@example.test`
  const password = `${randomUUID()}!Az9`
  await wrapper.get('[name=name]').setValue('Real API buyer')
  await wrapper.get('[name=email]').setValue(email)
  await wrapper.get('[name=password]').setValue(password)
  await wrapper.get('form').trigger('submit')
  await wait(() => wrapper.find('h1').text() === 'Оформление заказа')
  expect(responses).toContain('POST /api/cart/import 200')
  expect((await nativeFetch(`${origin.origin}/api/admin/orders`, { headers: browserHeaders() })).status).toBe(403)
  wrapper.unmount()
  wrapper = mount(App)
  await wait(() => text().includes('Real API buyer'))
  const secondTab = mount(App)
  try {
    await wait(() => secondTab.text().includes('Real API buyer'))
  } finally {
    secondTab.unmount()
  }
  expect((await nativeFetch(`${origin.origin}/api/me`, { headers: browserHeaders() })).status).toBe(200)
  const oldHeaders = browserHeaders()
  await wait(() => wrapper.findAll('article').length === 2)
  await wrapper.findAll('article').find(card => card.text().includes('UI integration pizza')).get('button').trigger('click')
  await wait(() => text().includes('Товар добавлен'))
  await click('Корзина')
  await wait(() => wrapper.find('[name=quantity]').exists())
  await wrapper.get('[name=quantity]').setValue(2)
  await wrapper.get('form').trigger('submit')
  await wait(() => text().includes('Итого по текущим ценам: 25.00'))
  await click('Оформить заказ')
  for (const field of ['region', 'city', 'street', 'house', 'postal_code']) await wrapper.get(`[name=${field}]`).setValue('Test address')
  await wrapper.get('form').trigger('submit')
  await wait(() => /Заказ №\d+ оформлен/.test(text()))
  const id = text().match(/Заказ №(\d+) оформлен/)[1]
  await click(`Подробнее о заказе №${id}`)
  await wait(() => wrapper.find('.order-detail').exists())
  expect(wrapper.get('.order-detail').text()).toContain('25.00')
  expect(wrapper.get('.order-detail').text()).toContain('UI integration pizza')
  await click('Корзина')
  await wait(() => text().includes('Корзина пуста'))
  await click('Выйти')
  await wait(() => text().includes('Вы вышли из аккаунта'))
  expect((await nativeFetch(`${origin.origin}/api/me`, { headers: oldHeaders })).status).toBe(401)
  await click('Войти')
  await wrapper.get('[name=email]').setValue('ui-admin@example.test')
  await wrapper.get('[name=password]').setValue(process.env.UI_TEST_ADMIN_PASSWORD)
  await wrapper.get('form').trigger('submit')
  await wait(() => text().includes('Заказы магазина'))
  await click('Заказы магазина')
  await click(`Подробнее о заказе №${id}`)
  await wait(() => wrapper.find('[name=status]').exists())
  expect(wrapper.get('.order-detail').text()).toContain(email)
  expect(wrapper.get('.order-detail').text()).toContain('25.00')
  await wrapper.get('[name=status]').setValue('in_process')
  await wrapper.get('form').trigger('submit')
  await wait(() => text().includes('Статус обновлён') && wrapper.find('[name=status]').exists())
  expect(wrapper.get('.order-detail').text()).toContain('Готовится')
  await wrapper.get('[name=status]').setValue('completed')
  await wrapper.get('form').trigger('submit')
  await wait(() => text().includes('Заказ закрыт'))
  await click('Выйти')
  await wait(() => text().includes('Вы вышли из аккаунта'))
  await click('Войти')
  await wrapper.get('[name=email]').setValue(email)
  await wrapper.get('[name=password]').setValue(password)
  await wrapper.get('form').trigger('submit')
  await wait(() => text().includes('Вы вошли в аккаунт'))
  await click('Мои заказы')
  await click(`Подробнее о заказе №${id}`)
  await wait(() => wrapper.find('.order-detail').exists())
  expect(wrapper.get('.order-detail').text()).toContain('Завершён')
  expect(text()).not.toContain('Заказы магазина')
}, 60000)
