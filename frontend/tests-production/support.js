import assert from 'node:assert/strict'

assert.ok(process.env.PRODUCTION_URL, 'Set PRODUCTION_URL to an isolated production deployment')
let parsedOrigin
try {
  parsedOrigin = new URL(process.env.PRODUCTION_URL)
} catch {
  throw new Error('PRODUCTION_URL must be a valid HTTP(S) origin')
}
export const origin = parsedOrigin
assert.ok(['http:', 'https:'].includes(origin.protocol))
assert.ok(!origin.username && !origin.password, 'PRODUCTION_URL must not contain credentials')
assert.ok(!origin.search && !origin.hash, 'PRODUCTION_URL must not contain a query or fragment')
assert.ok(origin.pathname === '/', 'PRODUCTION_URL must be an origin, without a path')

export const get = (path, options = {}) => fetch(new URL(path, origin), {
  redirect: 'error',
  signal: AbortSignal.timeout(10000),
  ...options,
})

export async function json(response, status) {
  assert.equal(response.status, status)
  assert.match(response.headers.get('content-type'), /application\/json/)
  assert.doesNotMatch(response.headers.get('cache-control') || '', /public|immutable/)
  return response.json()
}
