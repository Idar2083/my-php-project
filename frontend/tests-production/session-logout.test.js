import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'

// Run against the isolated multiprocess Laravel server described in SHOP-VERIFICATION.md.
const enabled = Boolean(process.env.AUTH_RACE_ORIGIN && process.env.AUTH_RACE_BARRIER_DIR)

test('concurrent logout permanently revokes the session', { skip: !enabled, timeout: 60000 }, async t => {
  const origin = new URL(process.env.AUTH_RACE_ORIGIN)
  assert.equal(origin.hostname, '127.0.0.1')
  const directory = process.env.AUTH_RACE_BARRIER_DIR
  const baseHeaders = { Accept: 'application/json', Origin: origin.origin, 'X-Pizza-Client': 'spa' }
  const request = (path, cookies = {}, { method = 'GET', body } = {}) => fetch(new URL('/api/' + path, origin), {
    method,
    headers: {
      ...baseHeaders,
      Cookie: Object.entries(cookies).map(([name, value]) => `${name}=${value}`).join('; '),
      ...(body && { 'Content-Type': 'application/json' }),
      ...(method === 'POST' && { 'X-XSRF-TOKEN': decodeURIComponent(cookies['XSRF-TOKEN']) }),
    },
    body: body && JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(30000),
  })
  function responseCookies(response) {
    return Object.fromEntries(response.headers.getSetCookie().map(cookie => {
      const pair = cookie.split(';', 1)[0]
      const separator = pair.indexOf('=')
      return [pair.slice(0, separator), pair.slice(separator + 1)]
    }))
  }
  async function privateStatus(cookies, expected) {
    const responses = await Promise.all(['me', 'cart'].map(path => request(path, cookies)))
    assert.deepEqual(responses.map(response => response.status), [expected, expected])
    return responses[0]
  }
  function fingerprint(response) {
    const hash = response.headers.get('X-Test-Session-Fingerprint')
    assert.ok(hash)
    return hash
  }
  async function signIn(path, credentials, cookies = {}) {
    const bootstrap = await request('csrf-cookie', cookies)
    assert.equal(bootstrap.status, 204)
    const initial = responseCookies(bootstrap)
    const result = await request(path, initial, { method: 'POST', body: credentials })
    assert.equal(result.status, 200)
    const authenticated = responseCookies(result)
    const sessionName = Object.keys(initial).find(name => name !== 'XSRF-TOKEN')
    assert.ok(sessionName)
    assert.ok(authenticated[sessionName])
    assert.notEqual(fingerprint(result), fingerprint(bootstrap))
    return { authenticated, sessionName, idHash: fingerprint(result) }
  }

  for (const [name, holdPastLogout, recheck] of [
    ['A: request finishes before the lock expires', false, false],
    ['B: request finishes after logout', true, false],
    ['C: old cookie is checked before the late response', true, true],
  ]) {
    await t.test(name, async () => {
      const id = randomUUID()
      const started = join(directory, id + '.started')
      const release = join(directory, id + '.release')
      const credentials = { email: id + '@example.test', password: randomUUID() + '!Aa1' }
      const { authenticated: original, sessionName, idHash } = await signIn('register', { name: 'Session fixture', ...credentials })
      await privateStatus(original, 200)

      const slow = request('__browser-session-race/' + id, original)
      try {
        const deadline = Date.now() + 5000
        while (!(await access(started).then(() => true, () => false))) {
          assert.ok(Date.now() < deadline, 'slow request did not load the session')
          await delay(25)
        }

        // Leave enough time for logout to acquire the lock after its lease expires.
        await delay(1000)
        let logoutFinished = false
        const logout = request('logout', original, { method: 'POST' }).then(response => {
          logoutFinished = true
          return response
        })

        await delay(250)
        assert.equal(logoutFinished, false, 'logout must wait while the session remains locked')
        if (!holdPastLogout) await writeFile(release, '')

        const loggedOut = await logout
        assert.equal(loggedOut.status, 200)
        const guest = responseCookies(loggedOut)
        assert.ok(guest[sessionName])
        assert.notEqual(fingerprint(loggedOut), idHash)

        let newLogin
        if (recheck) {
          const oldCookieRecheck = await privateStatus(original, 401)
          const rotatedGuest = responseCookies(oldCookieRecheck)
          assert.ok(rotatedGuest[sessionName])
          assert.notEqual(fingerprint(oldCookieRecheck), idHash)
          const signedInAgain = await signIn('login', credentials, guest)
          assert.notEqual(signedInAgain.idHash, idHash)
          newLogin = signedInAgain.authenticated
          await privateStatus(newLogin, 200)
        }

        if (holdPastLogout) await writeFile(release, '')
        const late = await slow
        assert.equal(late.status, 204)
        assert.equal(fingerprint(late), idHash)

        if (holdPastLogout) {
          const cookies = responseCookies(late)
          assert.equal(late.headers.getSetCookie().length, 0, 'late response must not set either cookie')
          await privateStatus(cookies, 401)
        }
        await privateStatus(original, 401)
        await privateStatus(newLogin ?? guest, newLogin ? 200 : 401)
      } finally {
        await writeFile(release, '')
        await slow.catch(() => {})
      }
    })
  }
})
