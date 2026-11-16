import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, chmodSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

const fixture = fileURLToPath(new URL('./background-fixture.php', import.meta.url))
const resourcePrefix = process.env.BACKGROUND_TEST_RESOURCE_PREFIX || `pizza-background-${process.pid}-`
assert.match(resourcePrefix, /^pizza-background-[a-z0-9-]+-$/)
const image = process.env.BACKGROUND_TEST_IMAGE
const cleanupFault = process.env.BACKGROUND_TEST_CLEANUP_FAILURE === '1'
const dockerEnv = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: 'unix:///var/run/docker.sock' }
function docker(...args) {
  const result = spawnSync('docker', args, { env: dockerEnv, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, `Isolated Docker command failed: ${args[0]}`)
  return result.stdout.trim()
}
function start(mode, directory, grace = '60') {
  if (!image) {
    const child = spawn('php', [fixture, mode, directory, grace], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
    return { child, signal: value => child.kill(value), cleanup() {}, async stopped() {} }
  }
  assert.match(image, /^sha256:[a-f0-9]{64}$/)
  chmodSync(directory, 0o777)
  const owner = directory.split('/').at(-1)
  const mounts = [
    [fixture, '/var/www/docker/release/background-fixture.php', true],
    [directory, '/fixture', false],
  ].flatMap(([source, target, readonly]) => ['--mount', `type=bind,src=${source},dst=${target}${readonly ? ',readonly' : ''}`])
  const container = docker('create', '--pull=never', '--network=none', '--read-only',
    '--cap-drop=ALL', '--security-opt=no-new-privileges', '--restart=no', '--stop-timeout=70',
    '--label', `pizza.background-test=${owner}`, ...mounts,
    '--entrypoint', 'php', image, '/var/www/docker/release/background-fixture.php', mode, '/fixture', grace, '/usr/local/bin/scheduler.php')
  try {
    assert.equal(docker('inspect', container, '--format', '{{.Config.Image}}'), image)
    assert.deepEqual(JSON.parse(docker('inspect', container, '--format', '{{json .Mounts}}')).map(mount => mount.Destination).sort(),
      ['/fixture', '/var/www/docker/release/background-fixture.php'])
  } catch (error) {
    assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "pizza.background-test"}}'), owner)
    docker('rm', '-f', container)
    throw error
  }
  let stopResult
  const child = spawn('docker', ['start', '-a', container], { env: dockerEnv, stdio: ['ignore', 'pipe', 'pipe'] })
  return {
    child,
    signal(value) {
      if (value === 'image-default') {
        const stop = spawn('docker', ['stop', container], { env: dockerEnv, stdio: 'ignore' })
        stopResult = new Promise(resolve => {
          stop.once('error', () => resolve(-1))
          stop.once('close', code => resolve(code))
        })
      } else docker('kill', '--signal', value, container)
      return true
    },
    async stopped() {
      if (stopResult) assert.equal(await stopResult, 0)
      assert.equal(docker('inspect', container, '--format', '{{.State.ExitCode}} {{.State.OOMKilled}} {{.State.Pid}}'), '0 false 0')
    },
    cleanup() {
      assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "pizza.background-test"}}'), owner)
      docker('rm', '-f', container)
    },
  }
}
function alive(pid) {
  try { process.kill(pid, 0); return true } catch (e) { if (e.code === 'ESRCH') return false; throw e }
}
async function cleanup(instance, child, done, directory) {
  try {
    if (child && child.exitCode === null && child.signalCode === null) {
      writeFileSync(join(directory, 'finish'), '')
      if (cleanupFault) await done // Deterministically exercise the already-stopped race.
      // The container may exit between releasing the gate and sending SIGTERM.
      // Always run cleanup, even if Docker reports that it has already stopped.
      try { instance.signal('SIGTERM') } catch { /* finally removes the owned container */ }
      await Promise.race([done, delay(3000, null, { ref: false })])
    }
  } finally {
    try { instance?.cleanup() } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await done
      }
      rmSync(directory, { recursive: true })
      assert.equal(existsSync(directory), false)
    }
  }
}
for (const mode of ['outbox', 'scheduler']) {
  for (const signal of ['SIGQUIT', 'SIGTERM', 'image-default']) {
    test(`${mode} drains current operation on ${signal} and reaps descendants`, { skip: signal === 'image-default' && !image, timeout: 15000 }, async () => {
      const directory = mkdtempSync(join(tmpdir(), resourcePrefix))
      let instance, child, done
      let stderr = ''
      const events = () => existsSync(join(directory, 'events')) ? readFileSync(join(directory, 'events'), 'utf8') : ''
      try {
        instance = start(mode, directory)
        child = instance.child
        child.stderr.on('data', data => { stderr += data })
        done = new Promise(resolve => child.on('close', (code, signal) => resolve({ code, signal })))
        const until = Date.now() + 8000
        while (!events().includes('READY ')) {
          assert.equal(child.exitCode, null, stderr)
          assert.ok(Date.now() < until, stderr || 'Readiness timed out')
          await delay(20)
        }
        assert.ok(instance.signal(signal))
        if (cleanupFault) throw new Error('EXPECTED_BACKGROUND_CLEANUP_FAULT')
        await delay(250)
        assert.equal(child.exitCode, null, 'Current operation was interrupted')
        assert.doesNotMatch(events(), /FINISHED|PUBLISHED|SECOND_CLAIM/)
        writeFileSync(join(directory, 'finish'), '')
        const result = await Promise.race([done, delay(3000, null, { ref: false })])
        assert.deepEqual(result, { code: 0, signal: null }, stderr)
        await instance.stopped()
        assert.equal(stderr, '')
        const log = events()
        assert.match(log, /FINISHED/)
        assert.doesNotMatch(log, /SECOND_CLAIM/)
        if (mode === 'outbox') assert.match(log, /CLAIM 1\nREADY \d+\nFINISHED\nPUBLISHED\n/)
        else assert.match(log, /MUTEX_RELEASED\nSCHEDULE_FINISHED\n/)
        if (image) assert.match(log, /PARENT 1\n/)
        else for (const [, pid] of log.matchAll(/(?:READY|SCHEDULE_RUN) (\d+)/g)) assert.equal(alive(Number(pid)), false)
      } finally {
        await cleanup(instance, child, done, directory)
      }
    })
  }
}

async function scenario(mode, { signal = 'SIGTERM', timeout = false, legacy = false, failure = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), resourcePrefix))
  let instance
  let child
  let done
  let stderr = ''
  const log = () => existsSync(join(directory, 'events')) ? readFileSync(join(directory, 'events'), 'utf8') : ''
  try {
    instance = start(mode, directory, timeout ? '1' : '60')
    child = instance.child
    child.stderr.on('data', data => { stderr += data })
    done = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })))
    if (!failure) {
      const ready = mode === 'outbox-idle' ? /IDLE/ : mode === 'scheduler-idle' ? /PARENT/ : /READY/
      const until = Date.now() + 8000
      while (!ready.test(log())) {
        assert.equal(child.exitCode, null, stderr)
        assert.ok(Date.now() < until, stderr || 'Fixture not ready')
        await delay(20)
      }
      if (legacy) writeFileSync(join(directory, 'finish'), '')
      else {
        instance.signal(signal)
        if (timeout && mode === 'outbox') {
          // Exercise the real deadline handler without waiting 60 seconds.
          await delay(100)
          instance.signal('SIGALRM')
        }
      }
    }
    const result = await Promise.race([done, delay(5000, null, { ref: false })])
    assert.deepEqual(result, { code: timeout ? 124 : failure ? 7 : 0, signal: null }, stderr)
    if (timeout) {
      assert.match(stderr, /shutdown deadline exceeded/)
      assert.doesNotMatch(log(), /FINISHED|PUBLISHED|SECOND_CLAIM/)
    } else if (failure) assert.equal(stderr, 'Scheduler command failed.\n')
    else {
      assert.equal(stderr, '')
      if (legacy) assert.match(log(), /CLAIM 100\nREADY \d+\nFINISHED\nPUBLISHED/)
      else assert.doesNotMatch(log(), /READY|SCHEDULE_RUN/)
    }
  } finally {
    await cleanup(instance, child, done, directory)
  }
}
for (const mode of ['outbox-idle', 'scheduler-idle']) {
  for (const signal of ['SIGQUIT', 'SIGTERM']) {
    test(`${mode} stops without starting another operation on ${signal}`, { timeout: 12000 }, () => scenario(mode, { signal }))
  }
}
test('outbox deadline handler returns 124 without publishing an unfinished event', { timeout: 12000 }, () => scenario('outbox', { timeout: true }))
test('scheduler deadline kills and reaps the whole session as PID 1', { skip: !image, timeout: 12000 }, () => scenario('scheduler', { timeout: true }))
test('scheduler child failure is a nonzero supervisor exit', { timeout: 12000 }, () => scenario('scheduler-failure', { failure: true }))
test('one-shot outbox preserves the default batch size', { timeout: 12000 }, () => scenario('outbox-legacy', { legacy: true }))

for (const mode of ['outbox', 'scheduler']) {
  test(`${mode} cleanup preserves the original failure when the process already stopped`, { timeout: 15000 }, () => {
    const directories = () => readdirSync(tmpdir()).filter(name => name.startsWith(resourcePrefix)).sort()
    const before = directories()
    const containers = image ? docker('ps', '-aq', '--filter', 'label=pizza.background-test') : null
    const env = { PATH: process.env.PATH, HOME: process.env.HOME, BACKGROUND_TEST_CLEANUP_FAILURE: '1', BACKGROUND_TEST_RESOURCE_PREFIX: resourcePrefix }
    if (image) env.BACKGROUND_TEST_IMAGE = image
    const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${mode} drains current operation on SIGQUIT`, fileURLToPath(import.meta.url)], {
      env, encoding: 'utf8', timeout: 12000,
    })
    assert.equal(result.status, 1)
    assert.match(result.stdout + result.stderr, /EXPECTED_BACKGROUND_CLEANUP_FAULT/)
    assert.deepEqual(directories(), before)
    if (image) assert.equal(docker('ps', '-aq', '--filter', 'label=pizza.background-test'), containers)
  })
}
