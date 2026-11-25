import assert from 'node:assert/strict'
import test from 'node:test'
import { get } from './support.js'

// Run only on an isolated deployment with its PHP service stopped.
test('backend failure stays an HTTP error while SPA and assets remain available', async () => {
  const spa = await get('/catalog/page/2')
  assert.equal(spa.status, 200)
  const html = await spa.text()
  const assetPath = html.match(/src="(\/assets\/[^" ]+\.js)"/)[1]
  assert.equal((await get(assetPath)).status, 200)
  for (const path of ['/api/products?page=1', '/up']) {
    const response = await get(path, { headers: { Accept: 'application/json' } })
    assert.ok([502, 504].includes(response.status), `${path}: ${response.status}`)
    assert.doesNotMatch(response.headers.get('cache-control') || '', /immutable|public/)
    assert.notEqual(await response.text(), html)
  }
})
