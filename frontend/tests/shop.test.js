import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../src/App.vue'
import { IDBFactory } from 'fake-indexeddb'
import OrdersView from '../src/components/OrdersView.vue'
import { ApiError } from '../src/api/client.js'
import { product, productPage } from './fixtures.js'

let wrapper
beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  wrapper?.unmount()
  localStorage.clear()
  sessionStorage.clear()
})
const order = { id: 9, status: 'created', total_price: '25.00', items: [{ id: 1, product_id: 7, product_name: 'Original pizza', price: '12.50', quantity: 2 }], delivery_method: 'delivery', address: { city: 'City' } }
const cart = { id: 1, user_id: 1, items: [{ id: 2, product_id: 7, quantity: 2, product: { ...product, price: 12.5 } }] }
function reply(data, status = 200) { return { ok: status < 400, status, json: async () => data } }
async function click(text) {
  const button = text === 'Корзина' ? wrapper.find('.cart-link')
    : wrapper.findAll('button').find(button => button.text() === text)
  expect(button, `button ${text}`).toBeTruthy()
  if (button.element.closest('.account-actions')?.style.display === 'none') {
    await wrapper.get('.account-name').trigger('click')
  }
  await button.trigger('click'); await flushPromises()
}
async function login(role = 'user') {
  const fetch = vi.fn(async (url) => {
    if (url.includes('/products')) return reply(productPage())
    if (url.endsWith('/csrf-cookie')) {
      document.cookie = 'XSRF-TOKEN=unit-csrf'
      return { ok: true, status: 204 }
    }
    if (url.endsWith('/login')) return reply({ id: 1, name: 'Buyer', role })
    if (url.endsWith('/me')) return reply({}, 401)
    if (url.endsWith('/logout')) return reply({ message: 'Logged out' })
    if (url.endsWith('/cart')) return reply({ data: cart })
    if (url.split('?')[0].endsWith('/orders')) return reply({ data: [order] })
    return reply({}, 404)
  })
  vi.stubGlobal('fetch', fetch)
  wrapper = mount(App)
  await flushPromises(); await click('Войти')
  await wrapper.get('[name=email]').setValue('buyer@example.test')
  await wrapper.get('[name=password]').setValue('SafePassword!123')
  await wrapper.get('form').trigger('submit')
  await vi.waitFor(() => expect(wrapper.get('.cart-link').text()).toBe('Корзина (2)'))
  return fetch
}

describe('buyer and administrator UI', () => {
  it('signs in with a cookie session, guards admin UI, loads the server cart, and logs out', async () => {
    const fetch = await login()
    expect(wrapper.text()).toContain('Вы вошли')
    expect(wrapper.text()).not.toContain('Заказы магазина')
    await click('Корзина')
    expect(wrapper.get('.cart-total .total').text()).toBe('25,00')
    expect(fetch.mock.calls.find(([url]) => url.endsWith('/cart'))[1].credentials).toBe('same-origin')
    await click('Выйти')
    expect(wrapper.text()).toContain('Вы вышли')
    expect(wrapper.text()).not.toContain('Мои заказы')
  })

  it('preserves a different guest pizza after 10 + 1 fails, edits the account and retries', async () => {
    let signedIn = false
    const guest = { ...product, id: 8 }
    const profile = { id: 1, name: 'Buyer', role: 'user' }
    let serverCart = { ...cart, items: [{ ...cart.items[0], quantity: 10 }] }
    const request = vi.fn(async (url, options) => {
      if (url.endsWith('/me')) return signedIn ? reply(profile) : reply({}, 401)
      if (url.endsWith('/csrf-cookie')) {
        document.cookie = 'XSRF-TOKEN=unit-csrf'
        return { ok: true, status: 204 }
      }
      if (url.endsWith('/login')) { signedIn = true; return reply(profile) }
      if (url.endsWith('/cart')) return reply({ data: serverCart })
      if (url.endsWith('/cart/items/2')) {
        const { quantity } = JSON.parse(options.body)
        serverCart = { ...serverCart, items: [{ ...serverCart.items[0], quantity }] }
        return reply({ data: serverCart })
      }
      if (url.endsWith('/cart/import')) {
        expect(options.headers['X-Pizza-Import-Account']).toBe('1')
        expect(JSON.parse(options.body)).toEqual({ items: [{ product_id: 8, quantity: 1 }] })
        if (serverCart.items[0].quantity === 10) return reply({ errors: { quantity: ['Не более 10 пицц.'] } }, 422)
        serverCart = { ...serverCart, items: [...serverCart.items, { id: 3, product: guest, quantity: 1 }] }
        return reply({ data: serverCart })
      }
      return reply(productPage([guest]))
    })
    vi.stubGlobal('fetch', request)
    wrapper = mount(App); await flushPromises()
    await click('В корзину')
    await vi.waitFor(() => expect(wrapper.get('.cart-link').text()).toBe('Корзина (1)'))
    wrapper.unmount()
    wrapper = mount(App); await flushPromises()
    await vi.waitFor(() => expect(wrapper.get('.cart-link').text()).toBe('Корзина (1)'))
    await click('Корзина (1)')
    await click('Оформить заказ')
    expect(wrapper.text()).toContain('Войдите или зарегистрируйтесь')
    await wrapper.get('[name=email]').setValue('buyer@example.test')
    await click('Зарегистрироваться')
    expect(wrapper.find('[name=name]').exists()).toBe(true)
    expect(wrapper.get('[name=email]').element.value).toBe('buyer@example.test')
    await click('Уже есть аккаунт? Войти')
    await wrapper.get('[name=password]').setValue('SafePassword!123')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.get('.guest-transfer').text()).toContain('Не более 10 пицц'))
    expect(wrapper.get('.cart-layout output').text()).toBe('10')
    expect(wrapper.get('.guest-transfer output').text()).toBe('1')
    const decrease = wrapper.get('.cart-layout .stepper button')
    await vi.waitFor(() => expect(decrease.attributes('disabled')).toBeUndefined())
    await decrease.trigger('click')
    await vi.waitFor(() => expect(wrapper.get('.cart-link').text()).toBe('Корзина (9)'))
    await click('Повторить перенос')
    await vi.waitFor(() => expect(wrapper.find('.guest-transfer').exists()).toBe(false))
    expect(wrapper.get('.cart-link').text()).toBe('Корзина (10)')
    await click('Оформить заказ')
    expect(wrapper.get('h1').text()).toBe('Оформление заказа')
  })

  it.each(['lost', 'different account'])('keeps imported rows when the reply is %s and does not retry on reload', async outcome => {
    let signedIn = false
    const profile = { id: 1, name: 'Buyer', role: 'user' }
    localStorage.setItem('pizza.guest-cart', JSON.stringify([{ product, quantity: 1 }]))
    const fetch = vi.fn(async url => {
      if (url.endsWith('/me')) return signedIn ? reply(profile) : reply({}, 401)
      if (url.endsWith('/csrf-cookie')) {
        document.cookie = 'XSRF-TOKEN=unit-csrf'
        return { ok: true, status: 204 }
      }
      if (url.endsWith('/login')) { signedIn = true; return reply(profile) }
      if (url.endsWith('/cart')) return reply({ data: cart })
      if (url.endsWith('/cart/import')) {
        if (outcome === 'lost') throw new Error('reply lost')
        return reply({ data: { ...cart, user_id: 2 } })
      }
      return reply(productPage())
    })
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App); await flushPromises()
    await click('Войти')
    await wrapper.get('[name=email]').setValue('buyer@example.test')
    await wrapper.get('[name=password]').setValue('SafePassword!123')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.find('.guest-transfer [role=alert]').exists()).toBe(true))
    await vi.waitFor(() => expect(wrapper.get('.guest-transfer > button').attributes('disabled')).toBeUndefined())
    expect(wrapper.get('.guest-transfer output').text()).toBe('1')
    wrapper.unmount()
    wrapper = mount(App)
    await vi.waitFor(() => expect(wrapper.get('.cart-link').text()).toBe('Корзина (2)'))
    await click('Корзина')
    await vi.waitFor(() => expect(wrapper.get('.guest-transfer output').text()).toBe('1'))
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/cart/import'))).toHaveLength(1)
  })

  it.each(['before POST', 'during POST', 'late error'])('keeps guest rows on account change %s', async phase => {
    const buyer = { id: 1, name: 'Buyer', role: 'user' }
    const nextBuyer = { id: 2, name: 'Next buyer', role: 'user' }
    let profile
    let resolveCheck
    let finishImport
    localStorage.setItem('pizza.guest-cart', JSON.stringify([{ product, quantity: 1 }]))
    const fetch = vi.fn(async (url, options) => {
      if (url.endsWith('/products')) return reply(productPage())
      if (url.endsWith('/csrf-cookie')) {
        document.cookie = 'XSRF-TOKEN=unit-csrf'
        return reply({}, 204)
      }
      if (url.endsWith('/login')) { profile = buyer; return reply(buyer) }
      if (url.endsWith('/me')) {
        if (!profile) return reply({}, 401)
        if (profile === buyer && phase === 'before POST') return new Promise(resolve => { resolveCheck = resolve })
        return reply(profile)
      }
      if (url.endsWith('/cart')) return reply({ data: { ...cart, user_id: profile.id } })
      if (url.endsWith('/cart/import')) {
        expect(options.headers['X-Pizza-Import-Account']).toBe('1')
        return new Promise(resolve => { finishImport = resolve })
      }
    })
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App)
    await flushPromises(); await click('Войти')
    await wrapper.get('[name=email]').setValue('buyer@example.test')
    await wrapper.get('[name=password]').setValue('SafePassword!123')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(resolveCheck || finishImport).toBeTypeOf('function'))
    profile = nextBuyer
    localStorage.setItem('pizza.session.changed', 'new-account')
    window.dispatchEvent(new StorageEvent('storage', { key: 'pizza.session.changed', newValue: 'new-account' }))
    if (resolveCheck) resolveCheck(reply(buyer))
    if (finishImport) finishImport(phase === 'late error' ? reply({}, 401) : reply({ data: cart }))
    await vi.waitFor(() => expect(wrapper.get('.account-name').text()).toBe('Next buyer'))
    await click('Корзина')
    await vi.waitFor(() => expect(wrapper.get('.guest-transfer output').text()).toBe('1'))
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/cart/import')))
      .toHaveLength(phase === 'before POST' ? 0 : 1)
  })

  it('adds to the authenticated cart, submits only address fields once and shows the confirmed order', async () => {
    const fetch = await login()
    const base = fetch.getMockImplementation()
    let finish
    fetch.mockImplementation((url, options) => {
      if (url.endsWith('/cart/items')) return Promise.resolve(reply({ data: cart }))
      if (url.endsWith('/orders') && options.method === 'POST') return new Promise(resolve => { finish = resolve })
      return base(url, options)
    })
    await click('В корзину')
    expect(fetch.mock.calls.at(-1)[0]).toBe('/api/cart/items')
    await click('Корзина')
    await click('Оформить заказ')
    for (const field of ['region', 'city', 'street', 'house', 'postal_code']) await wrapper.get(`[name=${field}]`).setValue('Value')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const sent = fetch.mock.calls.filter(([url, options]) => url.endsWith('/orders') && options.method === 'POST')
    expect(sent).toHaveLength(1)
    expect(Object.keys(JSON.parse(sent[0][1].body)).sort()).toEqual(['city', 'delivery_method', 'house', 'postal_code', 'region', 'street'])
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    finish(reply({ data: order })); await flushPromises()
    expect(wrapper.text()).toContain('Заказ №9 оформлен')
    expect(wrapper.text()).toContain('Original pizza')
    await click('Выйти')
    expect(wrapper.text()).toContain('Корзина (0)')
  })

  it('keeps the session and reports a failed logout', async () => {
    const fetch = await login()
    fetch.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(reply({ id: 1, name: 'Buyer', role: 'user' }))
    await click('Выйти')
    expect(wrapper.text()).toContain('Сервис недоступен')
    expect(wrapper.text()).toContain('Мои заказы')
  })

  it('returns to sign-in after an expired session', async () => {
    const fetch = await login()
    fetch.mockResolvedValueOnce(reply({}, 401))
    await click('Корзина')
    expect(wrapper.find('[name=password]').exists()).toBe(true)
    expect(wrapper.text()).toContain('Сессия завершена')
  })

  it('shows the administrator entry only for a verified admin profile', async () => {
    await login('admin')
    expect(wrapper.text()).toContain('Заказы магазина')
    await click('Заказы магазина')
    expect(wrapper.find('h1').text()).toBe('Заказы магазина')
  })

  it.each([0, 422, 503])('keeps the address and handles checkout response %s without an automatic retry', async status => {
    const fetch = await login()
    const base = fetch.getMockImplementation()
    fetch.mockImplementation((url, options) => url.endsWith('/orders') && options.method === 'POST'
      ? (status ? Promise.resolve(reply({ errors: { postal_code: ['Укажите индекс.'] } }, status)) : Promise.reject(new Error('response lost')))
      : base(url, options))
    await click('Корзина')
    await click('Оформить заказ')
    await wrapper.get('[name=city]').setValue('Томск')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.get('[role=alert]').exists()).toBe(true))
    expect(wrapper.get('[name=city]').element.value).toBe('Томск')
    expect(fetch.mock.calls.filter(([url]) => url.endsWith('/orders'))).toHaveLength(1)
    if (status === 422) {
      expect(wrapper.get('#checkout-postal_code').text()).toBe('Укажите индекс.')
      expect(wrapper.text()).not.toContain('создан ли заказ')
    } else {
      expect(wrapper.text()).toContain('создан ли заказ')
      expect(wrapper.text()).toContain('История заказов')
      expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined()
    }
  })

  it.each([true, false])('holds checkout after a lost response and a refilled cart (created: %s)', async created => {
    const fetch = await login()
    const base = fetch.getMockImplementation()
    let posted = false
    fetch.mockImplementation(async (url, options) => {
      if (url.endsWith('/orders') && options.method === 'POST') {
        posted = true
        throw new Error('response lost')
      }
      if (url.endsWith('/cart') && posted) return reply({ data: { ...cart, items: [{ ...cart.items[0], id: 3 }] } })
      if (url.endsWith('/orders?page=1')) return reply({ data: created && posted ? [order] : [] })
      if (url.endsWith('/orders/9') && created && posted) return reply({ data: order })
      return base(url, options)
    })
    await click('Корзина')
    await click('Оформить заказ')
    await wrapper.get('[name=city]').setValue('Томск')
    await wrapper.get('form').trigger('submit')
    await vi.waitFor(() => expect(wrapper.text()).toContain('создан ли заказ'))
    await click('Проверить корзину')
    expect(wrapper.get('[name=city]').element.value).toBe('Томск')
    expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined()
    await wrapper.get('form').trigger('submit')
    await click('История заказов')
    if (created) {
      await click('Подробнее о заказе №9')
      await click('Подтвердить заказ из этой отправки')
      expect(wrapper.get('h1').text()).toBe('Заказ оформлен')
      expect(wrapper.get('.order-detail').text()).toContain('Original pizza')
      expect(sessionStorage.getItem('pizza.order-review.1')).toBeNull()
    } else {
      expect(wrapper.text()).toContain('Заказов пока нет')
      expect(wrapper.text()).not.toContain('Заказ оформлен')
      await click('Корзина')
      await click('Оформить заказ')
      expect(wrapper.get('[name=city]').element.value).toBe('Томск')
      expect(wrapper.get('button[type=submit]').attributes('disabled')).toBeDefined()
    }
    expect(fetch.mock.calls.filter(([url, options]) => url.endsWith('/orders') && options.method === 'POST'))
      .toHaveLength(1)
  })

  it('updates quantities and deletes using item IDs, and shows an empty server cart', async () => {
    const fetch = await login()
    const base = fetch.getMockImplementation()
    fetch.mockImplementation((url, options) => url.endsWith('/cart/items/2')
      ? Promise.resolve(reply({ data: { ...cart, items: options.method === 'DELETE' ? [] : [
        { ...cart.items[0], quantity: 3 },
      ] } }))
      : base(url, options))
    await click('Корзина')
    await wrapper.get('.stepper button:last-child').trigger('click')
    await vi.waitFor(() => expect(wrapper.get('.cart-total .total').text()).toBe('37,50'))
    expect(JSON.parse(fetch.mock.lastCall[1].body)).toEqual({ quantity: 3 })
    await click('Удалить')
    await vi.waitFor(() => expect(wrapper.text()).toContain('Корзина пуста'))
    expect(fetch.mock.lastCall[1].method).toBe('DELETE')
  })

  it('uses snapshot names and only the transitions supplied by the backend, then locks a closed order', async () => {
    const adminOrder = { ...order, customer: { id: 1, name: 'Buyer', email: 'buyer@example.test' }, allowed_statuses: ['completed', 'cancelled'] }
    const request = vi.fn().mockResolvedValueOnce({ data: [adminOrder], meta: { last_page: 1 } })
      .mockResolvedValueOnce({ data: adminOrder }).mockResolvedValueOnce({ data: { ...order, status: 'completed' } })
      .mockResolvedValueOnce({ data: { ...adminOrder, status: 'completed', allowed_statuses: [] } })
    wrapper = mount(OrdersView, { props: { admin: true }, global: { provide: { api: { request } } } }); await flushPromises()
    await click('Подробнее о заказе №9')
    expect(wrapper.text()).toContain('Original pizza')
    expect(wrapper.text()).toContain('buyer@example.test')
    expect(wrapper.findAll('option').map(option => option.attributes('value'))).toEqual(['completed', 'cancelled'])
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(request).toHaveBeenCalledWith('/orders/9/status', { method: 'PUT', body: { status: 'completed' } })
    expect(wrapper.text()).toContain('Заказ закрыт')
    expect(wrapper.find('form').exists()).toBe(false)
  })

  it.each([403, 404, 409, 500])('handles order detail error %s without stale detail', async status => {
    const request = vi.fn().mockResolvedValueOnce({ data: [order] }).mockRejectedValueOnce(new ApiError(status))
    wrapper = mount(OrdersView, { global: { provide: { api: { request } } } }); await flushPromises()
    await click('Подробнее о заказе №9')
    expect(wrapper.find('[role=alert]').exists()).toBe(true)
    expect(wrapper.find('.order-detail').exists()).toBe(false)
  })

  it('keeps the acknowledged admin status when refreshing details fails', async () => {
    const adminOrder = { ...order, allowed_statuses: ['completed'] }
    const request = vi.fn()
      .mockResolvedValueOnce({ data: [adminOrder] }).mockResolvedValueOnce({ data: adminOrder })
      .mockResolvedValueOnce({ data: { ...order, status: 'completed' } }).mockRejectedValueOnce(new ApiError(503))
    wrapper = mount(OrdersView, { props: { admin: true }, global: { provide: { api: { request } } } })
    await flushPromises()
    await click('Подробнее о заказе №9')
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(wrapper.get('.order-detail').text()).toContain('Завершён')
    expect(wrapper.get('[role=alert]').text()).toContain('Статус сохранён')
    expect(wrapper.find('form').exists()).toBe(false)
    expect(request.mock.calls.filter(([, options]) => options?.method === 'PUT')).toHaveLength(1)
  })

  it('preserves the current order page when loading the next one fails', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [order], meta: { last_page: 2 } })
      .mockRejectedValueOnce(new ApiError(503))
    wrapper = mount(OrdersView, { global: { provide: { api: { request } } } })
    await flushPromises()
    await click('Далее')
    expect(wrapper.get('[role=alert]').text()).toContain('Сервис недоступен')
    expect(wrapper.get('.order-row').text()).toContain('№9')
    expect(wrapper.get('nav').text()).toContain('1 из 2')
  })

  it('paginates buyer history with the explicit opt-in query and preserves order details', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [order], meta: { last_page: 2 } })
      .mockResolvedValueOnce({ data: [{ ...order, id: 10 }], meta: { last_page: 2 } })
      .mockResolvedValueOnce({ data: { ...order, id: 10 } })
    wrapper = mount(OrdersView, { global: { provide: { api: { request } } } }); await flushPromises()
    expect(request).toHaveBeenNthCalledWith(1, '/orders?page=1')
    await click('Далее')
    expect(request).toHaveBeenNthCalledWith(2, '/orders?page=2')
    expect(wrapper.get('nav').text()).toContain('2 из 2')
    await click('Подробнее о заказе №10')
    expect(request).toHaveBeenLastCalledWith('/orders/10')
    expect(wrapper.get('.order-detail').text()).toContain('Original pizza')
  })

  it('paginates administrative orders using its own endpoint', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: [order], meta: { last_page: 2 } }).mockResolvedValueOnce({ data: [], meta: { last_page: 2 } })
    wrapper = mount(OrdersView, { props: { admin: true }, global: { provide: { api: { request } } } }); await flushPromises()
    await click('Далее')
    expect(request).toHaveBeenLastCalledWith('/admin/orders?page=2')
    expect(wrapper.text()).toContain('Заказов пока нет')
  })
})
