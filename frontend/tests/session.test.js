import { afterEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import App from '../src/App.vue'
import { jsonResponse, productPage } from './fixtures.js'

const profile = { id: 7, name: 'Session buyer', role: 'user' }
const mounted = []
const render = () => {
  const app = mount(App)
  mounted.push(app)
  return app
}
afterEach(() => mounted.splice(0).forEach(app => app.unmount()))

function stubSession(me) {
  const fetch = vi.fn((url, options) => url.endsWith('/me')
    ? me(options)
    : Promise.resolve(jsonResponse(productPage())))
  vi.stubGlobal('fetch', fetch)
  return fetch
}

it('keeps account controls pending and restores the profile in fresh roots', async () => {
  let resolve
  const initial = new Promise(done => { resolve = done })
  const fetch = stubSession(() => initial)
  const first = render()
  expect(first.text()).toContain('Проверяем сессию')
  expect(first.text()).not.toContain('Регистрация')
  resolve(jsonResponse(profile))
  await flushPromises()
  expect(first.text()).toContain(profile.name)
  const reloaded = render()
  const secondTab = render()
  await flushPromises()
  expect(reloaded.text()).toContain(profile.name)
  expect(secondTab.text()).toContain(profile.name)
  expect(fetch.mock.calls.filter(([url]) => url.endsWith('/me'))).toHaveLength(3)
  const [, options] = fetch.mock.calls.find(([url]) => url.endsWith('/me'))
  expect(options.credentials).toBe('same-origin')
  expect(options.headers.Authorization).toBeUndefined()
})

it('shows guest controls after a startup 401', async () => {
  stubSession(async () => ({ ok: false, status: 401 }))
  const app = render()
  await flushPromises()
  expect(app.text()).toContain('Регистрация')
  expect(app.text()).not.toContain('Проверяем сессию')
  expect(app.find('[role=alert]').exists()).toBe(false)
})

it.each(['500', 'network'])('reports a %s startup failure and supports retry', async outcome => {
  const me = vi.fn().mockResolvedValue(jsonResponse(profile))
  if (outcome === '500') me.mockResolvedValueOnce({ ok: false, status: 500 })
  else me.mockRejectedValueOnce(new Error('offline'))
  stubSession(me)
  const app = render()
  await flushPromises()
  expect(app.get('[role=alert]').text()).toContain('Сервис недоступен')
  const retry = app.findAll('button').find(button => button.text() === 'Повторить проверку сессии')
  await retry.trigger('click')
  await flushPromises()
  expect(app.text()).toContain(profile.name)
  expect(app.find('[role=alert]').exists()).toBe(false)
})

it('keeps a known profile on a transient tab recheck and clears it after session revocation', async () => {
  const me = vi.fn()
    .mockResolvedValueOnce(jsonResponse(profile))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ ok: false, status: 401 })
  stubSession(me)
  const app = render()
  await flushPromises()
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible')
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
  expect(app.text()).toContain(profile.name)
  expect(app.get('[role=alert]').text()).toContain('Сервис недоступен')
  document.dispatchEvent(new Event('visibilitychange'))
  await flushPromises()
  expect(app.text()).not.toContain(profile.name)
  expect(app.text()).toContain('Сессия завершена')
})
