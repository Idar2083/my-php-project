import assert from 'node:assert/strict'
import test from 'node:test'
import { get, json, origin } from './support.js'

test('SPA, built assets and cache policy', async () => {
  const response = await get('/')
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/html/)
  assert.match(response.headers.get('cache-control'), /no-cache/)
  const html = await response.text()
  assert.match(html, /<div id="app"><\/div>/)
  assert.doesNotMatch(html, /@vite\/client|\/src\/main\.js/)
  const paths = [...html.matchAll(/(?:src|href)="(\/assets\/[^" ]+)"/g)].map(m => m[1])
  assert.ok(paths.length >= 2)
  for (const path of paths) {
    const asset = await get(path)
    assert.equal(asset.status, 200)
    assert.match(asset.headers.get('cache-control'), /immutable/)
    if (path.endsWith('.css')) assert.match(asset.headers.get('content-type'), /text\/css/)
    if (path.endsWith('.js')) assert.match(asset.headers.get('content-type'), /(?:text|application)\/javascript/)
    const contents = await asset.text()
    assert.ok(contents.length > 0)
    assert.doesNotMatch(contents, /<!doctype html>/i)
    if (path.endsWith('.js')) {
      assert.ok(/['"\x60]\/api['"\x60]/.test(contents), 'Built client must use the same-origin API')
    }
    const etag = asset.headers.get('etag')
    assert.ok(etag)
    const unchanged = await get(path, { headers: { 'If-None-Match': etag } })
    assert.equal(unchanged.status, 304)
    assert.match(unchanged.headers.get('cache-control'), /immutable/)
  }
  const route = await get('/catalog/page/2?sort=price')
  assert.equal(route.status, 200)
  assert.equal(await route.text(), html)
  const index = await get('/index.html')
  assert.match(index.headers.get('cache-control'), /no-cache/)
  for (const path of [
    '/missing.js', '/missing.css', '/missing-stage122.ico', '/src/main.js',
    '/assets/missing.js', '/assets/missing-AAAAAAAA.js',
    '/.env', '/.git/config', '/index.php', '/debug.js.map',
    '/assets/.env', '/assets/review.js.map',
  ]) {
    const missing = await get(path)
    assert.equal(missing.status, 404, path)
    assert.doesNotMatch(missing.headers.get('cache-control') || '', /immutable/)
    assert.notEqual(await missing.text(), html)
  }
  // The isolated runner mounts these files, proving the rules apply to existing files.
  if (process.env.PRODUCTION_FIXTURES === '1') {
    const mutable = await get('/assets/review.txt')
    assert.equal(mutable.status, 200)
    assert.match(mutable.headers.get('content-type'), /text\/plain/)
    assert.match(mutable.headers.get('cache-control'), /no-cache/)
    assert.doesNotMatch(mutable.headers.get('cache-control'), /immutable/)
    assert.equal(await mutable.text(), 'mutable static fixture\n')
  }
})

test('Laravel API keeps query, errors, method, body and headers', async () => {
  const headers = { Accept: 'application/json', 'Accept-Language': 'ru' }
  const page = await json(await get('/api/products?page=2&review=stage122', { headers }), 200)
  assert.ok(Array.isArray(page.data))
  assert.equal(page.meta.current_page, 2)
  assert.ok(Number.isSafeInteger(page.meta.total) && page.meta.total >= 0)
  assert.ok(Number.isSafeInteger(page.meta.per_page) && page.meta.per_page > 0)
  assert.equal(page.data.length, Math.min(Math.max(page.meta.total - page.meta.per_page, 0), page.meta.per_page))
  const first = new URL(page.links.first)
  assert.equal(first.origin, origin.origin)
  assert.equal(first.pathname, '/api/products')
  assert.equal(first.searchParams.get('page'), '1')
  assert.equal(first.searchParams.get('review'), 'stage122')
  if (process.env.PRODUCTION_FIXTURES === '1') {
    assert.equal(page.meta.total, 31)
    assert.equal(page.data.length, 1)
    assert.equal(page.data[0].name, 'Stage 12.2 product 31')
    assert.equal(page.data[0].price, 12.5)
    assert.equal(page.data[0].weight, '0.500')
  }
  for (const path of ['/api', '/api/missing-stage122', '/api/products/2147483647']) {
    assert.equal(typeof (await json(await get(path, { headers }), 404)).message, 'string')
  }
  // Validation proves the POST body reaches Laravel without writing data.
  const invalid = await get('/api/login', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'invalid', password: '' }),
  })
  const validation = await json(invalid, 422)
  assert.ok(validation.errors.email?.length)
  assert.ok(validation.errors.password?.length)
  const empty = await get('/api/login', {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  })
  assert.notDeepEqual(validation.errors.email, (await json(empty, 422)).errors.email)
  const unauthorized = await json(await get('/api/me', { headers }), 401)
  const english = await json(await get('/api/me', {
    headers: { ...headers, 'Accept-Language': 'en' },
  }), 401)
  assert.equal(typeof unauthorized.message, 'string')
  assert.equal(typeof english.message, 'string')
  assert.notEqual(unauthorized.message, english.message)
  assert.equal((await get('/up')).status, 200)
})

test('Authorization reaches Laravel and user responses remain private', {
  skip: !process.env.PRODUCTION_TEST_TOKEN,
}, async () => {
  const response = await get('/api/me', {
    headers: { Accept: 'application/json', Authorization: `Bearer ${process.env.PRODUCTION_TEST_TOKEN}` },
  })
  const user = await json(response, 200)
  assert.match(response.headers.get('cache-control'), /private|no-store/)
  assert.ok(Number.isSafeInteger(user.id))
  assert.equal(user.email, process.env.PRODUCTION_TEST_USER_EMAIL)
  for (const field of ['password', 'remember_token', 'token', 'token_type']) {
    assert.equal(Object.hasOwn(user, field), false, field)
  }
})
