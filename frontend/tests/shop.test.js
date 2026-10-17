import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../src/App.vue'
import CheckoutView from '../src/components/CheckoutView.vue'
import CartView from '../src/components/CartView.vue'
import OrdersView from '../src/components/OrdersView.vue'
import { ApiError } from '../src/api/client.js'
import { product, productPage } from './fixtures.js'

let wrapper
afterEach(() => wrapper?.unmount())
const order = { id: 9, status: 'created', total_price: '25.00', items: [{ id: 1, product_id: 7, product_name: 'Original pizza', price: '12.50', quantity: 2 }], delivery_method: 'delivery', address: { city: 'City' } }
const cart = { id: 1, items: [{ id: 2, product_id: 7, quantity: 2, product: { ...product, price: 12.5 } }] }
function reply(data, status = 200) { return { ok: status < 400, status, json: async () => data } }
async function click(text) {
  const button = wrapper.findAll('button').find(button => button.text() === text)
  expect(button, `button ${text}`).toBeTruthy()
  await button.trigger('click'); await flushPromises()
}
async function login(role = 'user') {
  const fetch = vi.fn(async (url) => {
    if (url.includes('/products')) return reply(productPage())
    if (url.endsWith('/login')) return reply({ token: 'unit-jwt', token_type: 'bearer' })
    if (url.endsWith('/me')) return reply({ id: 1, name: 'Buyer', role })
    if (url.endsWith('/logout')) return reply({ message: 'Logged out' })
    if (url.endsWith('/cart')) return reply({ data: cart })
    if (url.split('?')[0].endsWith('/orders')) return reply({ data: [order] })
    return reply({}, 404)
  })
  vi.stubGlobal('fetch', fetch)
  wrapper = mount(App)
  await flushPromises(); await click('Вход')
  await wrapper.get('[name=email]').setValue('buyer@example.test')
  await wrapper.get('[name=password]').setValue('SafePassword!123')
  await wrapper.get('form').trigger('submit'); await flushPromises()
  return fetch
}

describe('buyer and administrator UI', () => {
  it('signs in with JWT, guards admin UI, loads the server cart, and logs out', async () => {
    const fetch = await login()
    expect(wrapper.text()).toContain('Вы вошли')
    expect(wrapper.text()).not.toContain('Заказы магазина')
    await click('Корзина')
    expect(wrapper.text()).toContain('Итого по текущим ценам: 25.00')
    expect(fetch.mock.calls.find(([url]) => url.endsWith('/cart'))[1].headers.Authorization).toBe('Bearer unit-jwt')
    await click('Выйти')
    expect(wrapper.text()).toContain('Вы вышли')
    expect(wrapper.text()).not.toContain('Мои заказы')
  })

  it('opens sign-in before attempting to add a guest item', async () => {
    const fetch = vi.fn(async () => reply(productPage()))
    vi.stubGlobal('fetch', fetch)
    wrapper = mount(App); await flushPromises()
    await click('Войти и заказать')
    expect(wrapper.find('[name=password]').exists()).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
  })

  it('drops the local session when logout cannot reach the server', async () => {
    const fetch = await login()
    fetch.mockRejectedValueOnce(new Error('offline'))
    await click('Выйти')
    expect(wrapper.text()).toContain('Сервер не подтвердил отзыв токена')
    expect(wrapper.text()).not.toContain('Мои заказы')
  })

  it('returns to sign-in after an expired JWT', async () => {
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

  it('submits only supported address fields and blocks a second checkout submission', async () => {
    let resolve
    const request = vi.fn(() => new Promise(done => { resolve = done }))
    wrapper = mount(CheckoutView, { global: { provide: { api: { request } } } })
    for (const field of ['region', 'city', 'street', 'house', 'postal_code']) await wrapper.get(`[name=${field}]`).setValue('Value')
    await wrapper.get('form').trigger('submit')
    await wrapper.get('form').trigger('submit')
    expect(request).toHaveBeenCalledTimes(1)
    const [, options] = request.mock.calls[0]
    expect(Object.keys(options.body).sort()).toEqual(['delivery_method', 'region', 'city', 'street', 'house', 'apartment', 'entrance', 'postal_code'].sort())
    expect(options.body.total_price).toBeUndefined()
    expect(wrapper.get('fieldset').attributes('disabled')).toBeDefined()
    resolve({ data: order }); await flushPromises()
    expect(wrapper.emitted('ordered')[0][0]).toEqual(order)
  })

  it('offers order history after an uncertain checkout outcome without retrying automatically', async () => {
    const request = vi.fn().mockRejectedValue(new ApiError(0))
    wrapper = mount(CheckoutView, { global: { provide: { api: { request } } } })
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(wrapper.text()).toContain('заказ мог быть создан')
    expect(wrapper.emitted('ordered')).toBeUndefined()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('updates quantities and deletes using item IDs, and shows an empty server cart', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: cart }).mockResolvedValueOnce({ data: { ...cart, items: [{ ...cart.items[0], quantity: 3 }] } }).mockResolvedValueOnce({ data: { id: 1, items: [] } })
    wrapper = mount(CartView, { global: { provide: { api: { request } } } }); await flushPromises()
    await wrapper.get('[name=quantity]').setValue(3)
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(request).toHaveBeenNthCalledWith(2, '/cart/items/2', { method: 'PUT', body: { quantity: 3 } })
    expect(wrapper.text()).toContain('37.50')
    await click('Удалить')
    expect(request).toHaveBeenNthCalledWith(3, '/cart/items/2', { method: 'DELETE' })
    expect(wrapper.text()).toContain('Корзина пуста')
  })

  it('shows server-side category limits without changing the displayed cart', async () => {
    const request = vi.fn().mockResolvedValueOnce({ data: cart }).mockRejectedValueOnce(new ApiError(422, ['Не более 10 пицц.']))
    wrapper = mount(CartView, { global: { provide: { api: { request } } } }); await flushPromises()
    await wrapper.get('form').trigger('submit'); await flushPromises()
    expect(wrapper.get('[role=alert]').text()).toContain('Не более 10 пицц')
    expect(wrapper.text()).toContain('25.00')
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
