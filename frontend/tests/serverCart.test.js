import { afterEach, expect, it, vi } from 'vitest'
import { useServerCart } from '../src/useServerCart.js'
import { ApiError } from '../src/api/client.js'

const response = (quantity, user_id = 1) => ({
  data: { user_id, items: quantity ? [{ id: 2, quantity, product: { id: 7, price: 10 } }] : [] },
})

afterEach(() => vi.useRealTimers())

it('coalesces rapid edits, then applies additional edits after the running PUT', async () => {
  vi.useFakeTimers()
  let finish
  const request = vi.fn().mockResolvedValueOnce(response(2))
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve }))
    .mockResolvedValueOnce(response(4))
  const cart = useServerCart({ request }, () => 1)
  await cart.refresh()
  cart.adjust(2, 1)
  cart.adjust(2, 1)
  cart.adjust(2, -1)
  await vi.advanceTimersByTimeAsync(200)
  cart.adjust(2, 1)
  expect(request.mock.calls).toHaveLength(2)
  expect(request.mock.lastCall[1].body).toEqual({ quantity: 3 })
  finish(response(3))
  await vi.advanceTimersByTimeAsync(210)
  expect(request.mock.lastCall[1].body).toEqual({ quantity: 4 })
  expect(cart.count.value).toBe(4)
})

it('keeps a scheduled removal after an in-flight quantity error', async () => {
  vi.useFakeTimers()
  let reject
  const request = vi.fn().mockResolvedValueOnce(response(2))
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    .mockResolvedValueOnce(response(0))
  const cart = useServerCart({ request }, () => 1)
  await cart.refresh()
  cart.adjust(2, 1)
  await vi.advanceTimersByTimeAsync(200)
  cart.remove(2)
  reject(new ApiError(422))
  await vi.advanceTimersByTimeAsync(210)
  expect(request.mock.lastCall).toEqual(['/cart/items/2', { method: 'DELETE' }])
  expect(cart.count.value).toBe(0)
})

it('discards a late read and rejects a response from a previous session', async () => {
  let finishRead
  let finishMutation
  let account = 1
  const request = vi.fn().mockImplementationOnce(() => new Promise(resolve => { finishRead = resolve }))
    .mockResolvedValueOnce(response(3))
    .mockImplementationOnce(() => new Promise(resolve => { finishMutation = resolve }))
    .mockResolvedValueOnce(response(4, 5))
  const cart = useServerCart({ request }, () => account)
  const oldRead = cart.refresh()
  await cart.add({ id: 7 }, 1)
  finishRead(response(1))
  await oldRead
  expect(cart.count.value).toBe(3)
  const old = cart.add({ id: 7 }, 1)
  account = 5
  cart.reset()
  await cart.refresh()
  finishMutation(response(9))
  await old
  expect(cart.count.value).toBe(4)
})

it('reverts on 422 and reconciles an ambiguous mutation before exposing the next action', async () => {
  vi.useFakeTimers()
  const rejected = new ApiError(422, ['Не более 10 пицц.'])
  const request = vi.fn().mockResolvedValueOnce(response(2)).mockRejectedValueOnce(rejected)
    .mockRejectedValueOnce(new ApiError(0)).mockResolvedValueOnce(response(3))
  const cart = useServerCart({ request }, () => 1)
  await cart.refresh()
  cart.adjust(2, 1)
  await vi.advanceTimersByTimeAsync(200)
  expect(cart.rowErrors[2]).toBe(rejected)
  expect(cart.count.value).toBe(2)
  cart.adjust(2, 1)
  await vi.advanceTimersByTimeAsync(200)
  expect(request.mock.lastCall).toEqual(['/cart'])
  expect(cart.count.value).toBe(3)
})

it('replays the latest 2 → 3 → 4 intent once after a lost PUT and an unchanged GET', async () => {
  vi.useFakeTimers()
  let reject
  const request = vi.fn().mockResolvedValueOnce(response(2))
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    .mockResolvedValueOnce(response(2)).mockResolvedValueOnce(response(4))
  const cart = useServerCart({ request }, () => 1)
  await cart.refresh()
  cart.adjust(2, 1)
  await vi.advanceTimersByTimeAsync(200)
  cart.adjust(2, 1)
  expect(cart.pending[2].quantity).toBe(4)
  expect(cart.count.value).toBe(2)
  reject(new ApiError(0))
  await vi.advanceTimersByTimeAsync(200)
  expect(request.mock.calls).toEqual([
    ['/cart'], ['/cart/items/2', { method: 'PUT', body: { quantity: 3 } }],
    ['/cart'], ['/cart/items/2', { method: 'PUT', body: { quantity: 4 } }],
  ])
  expect(cart.count.value).toBe(4)
  expect(cart.pending[2]).toBeUndefined()
})

it('pauses after a bounded retry and retains the unconfirmed quantity for explicit reconciliation', async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValueOnce(response(2))
    .mockRejectedValueOnce(new ApiError(0)).mockResolvedValueOnce(response(2))
    .mockRejectedValueOnce(new ApiError(0)).mockResolvedValueOnce(response(2))
    .mockResolvedValueOnce(response(2)).mockResolvedValueOnce(response(3))
  const cart = useServerCart({ request }, () => 1)
  await cart.refresh()
  cart.adjust(2, 1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(request).toHaveBeenCalledTimes(5)
  expect(cart.paused.has('2')).toBe(true)
  expect(cart.pending[2].quantity).toBe(3)
  expect(cart.count.value).toBe(2)
  await cart.retryRow(2)
  await vi.advanceTimersByTimeAsync(200)
  expect(cart.count.value).toBe(3)
  expect(cart.pending[2]).toBeUndefined()
})

it('honors a removal queued during a lost PUT after checking the server', async () => {
  vi.useFakeTimers()
  let reject
  const request = vi.fn().mockResolvedValueOnce(response(2))
    .mockImplementationOnce(() => new Promise((_, fail) => { reject = fail }))
    .mockResolvedValueOnce(response(3)).mockResolvedValueOnce(response(0))
  const cart = useServerCart({ request }, () => 1)
  await cart.refresh()
  cart.adjust(2, 1)
  await vi.advanceTimersByTimeAsync(200)
  cart.remove(2)
  reject(new ApiError(0))
  await vi.advanceTimersByTimeAsync(200)
  expect(request.mock.calls.slice(2)).toEqual([['/cart'], ['/cart/items/2', { method: 'DELETE' }]])
  expect(cart.count.value).toBe(0)
})

it('replaces a paused quantity update with an explicit removal', async () => {
  vi.useFakeTimers()
  const request = vi.fn().mockResolvedValueOnce(response(2))
    .mockRejectedValueOnce(new ApiError(0)).mockResolvedValueOnce(response(2))
    .mockRejectedValueOnce(new ApiError(0)).mockResolvedValueOnce(response(2))
    .mockResolvedValueOnce(response(0))
  const cart = useServerCart({ request }, () => 1)
  await cart.refresh()
  cart.adjust(2, 1)
  await vi.advanceTimersByTimeAsync(2000)
  expect(cart.paused.has('2')).toBe(true)
  expect(cart.pending[2].quantity).toBe(3)

  cart.remove(2)
  await vi.advanceTimersByTimeAsync(200)

  expect(request.mock.calls.slice(5)).toEqual([['/cart/items/2', { method: 'DELETE' }]])
  expect(cart.count.value).toBe(0)
  expect(cart.paused.has('2')).toBe(false)
  expect(cart.pending[2]).toBeUndefined()
  expect(cart.loading.value).toBe(false)
})
