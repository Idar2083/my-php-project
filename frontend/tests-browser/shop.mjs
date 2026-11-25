import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { pathToFileURL } from 'node:url'

assert.ok(process.env.PLAYWRIGHT_MODULE, 'Set PLAYWRIGHT_MODULE to Playwright index.mjs')
const playwright = await import(pathToFileURL(process.env.PLAYWRIGHT_MODULE))
const engine = process.env.PLAYWRIGHT_BROWSER || 'chromium'
const browser = await playwright[engine].launch()
const products = [
  { id: 1, name: 'Маргарита', category: 'pizza', price: 799, description: 'Томатный соус.', weight: '0.450' },
  { id: 2, name: 'Пицца ' + 'д'.repeat(75), category: 'pizza', price: 899, description: 'Сыр.', weight: '0.500' },
]
const account = { id: 7, name: 'Покупатель ' + 'д'.repeat(90), role: 'admin' }
const cart = { id: 1, user_id: account.id, items: products.map(product => ({ id: product.id, product, quantity: 1 })) }
const errors = []
const origin = 'http://pizza.test'
const url = path => new URL('../dist/' + path, import.meta.url)
const productButton = (page, i) => page.getByRole('button', { name: 'В корзину', exact: true }).nth(i)
const button = (page, name) => page.getByRole('button', { name, exact: true })

async function context(options, signedIn = false) {
  const result = await browser.newContext(options)
  result.on('page', page => page.on('pageerror', error => errors.push(error)))
  await result.route('**/*', async route => {
    const path = new URL(route.request().url()).pathname
    if (path === '/api/me') return route.fulfill(signedIn ? { json: account } : { status: 401, json: {} })
    if (path === '/api/cart') return route.fulfill({ json: { data: cart } })
    if (path === '/api/products') return route.fulfill({ json: {
      data: products, meta: { current_page: 1, last_page: 1, total: 2, per_page: 30 },
    } })
    if (path === '/api/orders' || path === '/api/admin/orders') return route.fulfill({ json: { data: [] } })
    if (path === '/' || path.startsWith('/assets/')) {
      const file = path === '/' ? 'index.html' : 'assets/' + basename(path)
      return route.fulfill({ body: await readFile(url(file)),
        contentType: path === '/' ? 'text/html' : path.endsWith('.css') ? 'text/css' : 'text/javascript' })
    }
    return route.fulfill({ status: 404 })
  })
  return result
}

async function cartCount(page, count) {
  await button(page, `Корзина (${count})`).waitFor()
}

async function overflow(page, label) {
  const { width, actual } = await page.evaluate(() => ({
    width: document.documentElement.clientWidth, actual: document.documentElement.scrollWidth,
  }))
  if (actual > width) {
    const offenders = await page.evaluate(() => [...document.querySelectorAll('body *')]
      .filter(node => node.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
      .slice(0, 10).map(node => node.className || node.tagName))
    assert.fail(`${label}: ${actual} > ${width} (${offenders.join(', ')})`)
  }
}

try {
  const tabs = await context()
  const a = await tabs.newPage()
  const b = await tabs.newPage()
  await Promise.all([a.goto(origin), b.goto(origin)])
  await Promise.all([productButton(a, 0).click(), productButton(b, 1).click()])
  await Promise.all([cartCount(a, 2), cartCount(b, 2)])
  await Promise.all([button(a, 'Корзина (2)').click(), button(b, 'Корзина (2)').click()])
  const increase = page => button(page, 'Увеличить количество: Маргарита')
  await Promise.all([increase(a).click(), increase(b).click()])
  await Promise.all([cartCount(a, 4), cartCount(b, 4)])
  // Bind both actions before dispatch so one tab's repaint does not remove the other button.
  await Promise.all([
    button(a, 'Удалить: Маргарита').evaluate(node => node.click()),
    increase(b).evaluate(node => node.click()),
  ])
  await cartCount(b, 1)
  await b.reload()
  await cartCount(b, 1)
  await button(b, 'Корзина (1)').click()
  assert.equal(await increase(b).count(), 0)
  await tabs.close()
  console.log(`Two ${engine} tabs: concurrent adds, increments, removal race and reload passed.`)

  for (const width of [360, 390, 768, 1024, 1440]) {
    const guest = await context({ viewport: { width, height: 800 } })
    const page = await guest.newPage()
    await page.goto(origin)
    await productButton(page, 0).waitFor()
    await overflow(page, `catalog ${width}`)
    await button(page, 'Войти').click()
    await overflow(page, `login ${width}`)
    await button(page, 'Зарегистрироваться').click()
    await overflow(page, `register ${width}`)
    await guest.close()

    const member = await context({ viewport: { width, height: 800 } }, true)
    const logged = await member.newPage()
    await logged.goto(origin)
    await cartCount(logged, 2)
    await button(logged, 'Корзина (2)').click()
    await overflow(logged, `cart ${width}`)
    await button(logged, 'Оформить заказ').click()
    await logged.getByRole('heading', { name: 'Оформление заказа' }).waitFor()
    await overflow(logged, `checkout ${width}`)
    const trigger = logged.locator('.account-name')
    await trigger.press('Enter')
    await button(logged, 'Заказы магазина').focus()
    await logged.keyboard.press('Escape')
    assert.equal(await trigger.getAttribute('aria-expanded'), 'false')
    assert.ok(await trigger.evaluate(node => node === document.activeElement))
    await trigger.press('Space')
    await button(logged, 'Заказы магазина').click()
    await overflow(logged, `orders ${width}`)
    if (width === 768) {
      await logged.evaluate(() => { document.documentElement.style.fontSize = '200%' })
      await overflow(logged, 'orders 200% text')
      await logged.evaluate(() => {
        document.documentElement.style.fontSize = ''
        document.documentElement.style.zoom = '2'
      })
      await overflow(logged, 'orders 200% zoom')
    }
    await member.close()
    console.log(`${engine} layout and account keyboard controls: ${width}px passed.`)
  }
  assert.deepEqual(errors, [])
} finally {
  await browser.close()
}
