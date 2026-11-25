import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { IDBFactory } from 'fake-indexeddb'
import { mount } from '@vue/test-utils'
import { useGuestCart } from '../src/guestCart.js'
import { legacyKey } from '../src/guestCartStorage.js'

const mounts = []
const pizza = { id: 1, name: 'Маргарита', price: 750, category: 'pizza' }
const other = { ...pizza, id: 2, name: 'Пепперони' }

beforeEach(() => vi.stubGlobal('indexedDB', new IDBFactory()))
afterEach(() => {
  for (const wrapper of mounts.splice(0)) wrapper.unmount()
  localStorage.clear()
})

async function tab() {
  let cart
  mounts.push(mount({ setup() { cart = useGuestCart(); return () => null } }))
  await cart.ready
  return cart
}

it('migrates the legacy snapshot once and restores confirmed changes on reload', async () => {
  localStorage.setItem(legacyKey, JSON.stringify([{ product: pizza, quantity: 2 }]))
  const first = await tab()
  expect(first.count.value).toBe(2)
  expect(localStorage.getItem(legacyKey)).toBeNull()
  await first.add(pizza)
  localStorage.setItem(legacyKey, JSON.stringify([{ product: pizza, quantity: 1 }]))
  const second = await tab()
  expect(second.count.value).toBe(3)
  expect(second.warning.value).toContain('старой версии')
  expect(localStorage.getItem(legacyKey)).not.toBeNull()
})

it('serializes concurrent adds and applies both increments to the current quantity', async () => {
  const a = await tab()
  const b = await tab()
  await Promise.all([a.add(pizza), b.add(other)])
  await b.refresh()
  expect(b.items.value.map(item => item.id)).toEqual([1, 2])
  const item = b.items.value[0]
  await Promise.all([a.adjust(item, 1), b.adjust(item, 1)])
  const reload = await tab()
  expect(reload.items.value.map(item => item.quantity)).toEqual([3, 1])
})

it('does not recreate a removed item from a stale increment', async () => {
  const a = await tab()
  const b = await tab()
  await a.add(pizza)
  await b.refresh()
  const [, result] = await Promise.allSettled([a.remove(pizza.id), b.adjust(b.items.value[0], 1)])
  expect(result.status).toBe('rejected')
  await b.refresh()
  expect(b.items.value).toEqual([])
})

it('keeps newly added rows and requires review after a lost import reply', async () => {
  const a = await tab()
  const b = await tab()
  await a.add(pizza)
  const first = await a.beginImport(10)
  expect(await b.beginImport(10)).toBeUndefined()
  await a.finishImport(first, false, true)
  expect(await b.beginImport(10)).toBeUndefined()
  const retry = await b.beginImport(10, true)
  await a.add(other)
  await b.finishImport(retry, true)
  expect(b.items.value.map(item => item.id)).toEqual([2])
})

it('offers only temporary storage when IndexedDB is unavailable', async () => {
  vi.stubGlobal('indexedDB', undefined)
  const a = await tab()
  await a.add(pizza)
  expect(a.warning.value).toContain('только в этой вкладке')
  expect(localStorage.getItem(legacyKey)).toBeNull()
  expect((await tab()).count.value).toBe(0)
})
