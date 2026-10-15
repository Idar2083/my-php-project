import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { exerciseWorker, graceSeconds } from './queue-worker-test-support.mjs'

// Opt-in only. Accept a local immutable image ID, never a tag that could pull.
const image = process.env.QUEUE_WORKER_TEST_IMAGE
const fixture = fileURLToPath(new URL('./queue-worker-fixture.php', import.meta.url))
const environment = { PATH: process.env.PATH, DOCKER_HOST: 'unix:///var/run/docker.sock' }
for (const name of ['HOME', 'DOCKER_CONFIG']) {
  if (process.env[name]) environment[name] = process.env[name]
}
function docker(...args) {
  const result = spawnSync('docker', args, { env: environment, encoding: 'utf8', timeout: 15000 })
  assert.equal(result.status, 0, `Local Docker command failed: ${args[0]}`)
  return result.stdout.trim()
}

for (const mode of ['SIGQUIT', 'SIGTERM', 'image-default']) {
  test(`isolated image worker shutdown: ${mode}`, { skip: !image, timeout: 30000 }, async () => {
    assert.match(image, /^sha256:[a-f0-9]{64}$/)
    const stopSignal = docker('image', 'inspect', image, '--format', '{{.Config.StopSignal}}')
    assert.equal(stopSignal, 'SIGQUIT', 'Keep the production PHP-FPM StopSignal unchanged')
    const owner = randomUUID()
    let container
    let child
    let stopResult
    try {
      container = docker('create', '-i', '--pull=never', '--network=none', '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777', '--cap-drop=ALL',
        '--security-opt=no-new-privileges', '--restart=no', '--stop-timeout', String(graceSeconds),
        '--label', `pizza.queue-signal-test=${owner}`,
        '--mount', `type=bind,src=${fixture},dst=/queue-worker-fixture.php,readonly`,
        '--entrypoint', 'php', image, '/queue-worker-fixture.php', '/var/www/app/vendor/autoload.php')
      assert.match(container, /^[a-f0-9]{64}$/)
      child = spawn('docker', ['start', '-ai', container], { env: environment, stdio: ['pipe', 'pipe', 'pipe'] })
      const number = mode === 'SIGTERM' ? 15 : 3
      await exerciseWorker(child, number, () => {
        if (mode !== 'image-default') docker('kill', '--signal', mode, container)
        else {
          const stop = spawn('docker', ['stop', '-t', String(graceSeconds), container], {
            env: environment, stdio: 'ignore',
          })
          stopResult = new Promise(resolve => {
            stop.once('error', () => resolve(-1))
            stop.once('close', code => resolve(code))
          })
        }
      }, { pidOne: true })
      if (stopResult) assert.equal(await stopResult, 0)
      const state = JSON.parse(docker('inspect', container, '--format', '{{json .State}}'))
      assert.equal(state.ExitCode, 0)
      assert.equal(state.OOMKilled, false)
      assert.equal(state.Running, false)
    } finally {
      // Remove only the container created by this test, after checking its label.
      if (container) {
        assert.equal(docker('inspect', container, '--format', '{{index .Config.Labels "pizza.queue-signal-test"}}'), owner)
        docker('rm', '-f', container)
      }
      if (child && child.exitCode === null && child.signalCode === null) child.kill()
      if (stopResult) await stopResult
    }
  })
}
