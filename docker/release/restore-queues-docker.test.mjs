import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { spawnSync } from 'node:child_process'
import { DockerCoordinator } from './coordinator-docker.mjs'
import { queuesEmpty } from './restore-release.mjs'

test('recovery queue preflight accepts the real RabbitMQ JSON protocol in an isolated container', {
  skip: process.env.RESTORE_QUEUES_DOCKER_TEST !== '1', timeout: 90000,
}, () => {
  const owner = randomUUID(), driver = new DockerCoordinator({})
  const run = driver.backup.run.bind(driver.backup)
  const image = run(['image', 'inspect', 'rabbitmq:3.13-management-alpine', '--format', '{{.Id}}'])
  const id = run(['create', '--pull=never', '--network=none', '--hostname=localhost', '--user=0',
    '--tmpfs', '/var/lib/rabbitmq:rw', '--label', 'pizza.restore-queues-test=' + owner,
    '--env', 'RABBITMQ_SERVER_ADDITIONAL_ERL_ARGS=+S 2:2', '--env', 'RABBITMQ_CTL_ERL_ARGS=+S 1:1', image])
  try {
    run(['start', id])
    let ready = false
    for (let n = 0; n < 100; n++) {
      // Root CLI probes before server initialization can create a root-owned
      // cookie in the shared HOME, preventing the rabbitmq user from booting.
      try { run(['exec', '--user', 'rabbitmq', id, 'rabbitmq-diagnostics', '-q', 'check_running'], { discardOutput: true });ready = true;break } catch {}
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 200)
    }
    if (!ready) {
      const diagnostic = spawnSync('docker', ['exec', '--user', 'rabbitmq', id, 'rabbitmq-diagnostics', '-q', 'ping'], { encoding: 'utf8' })
      const logs = run(['logs', id]) + diagnostic.stdout + diagnostic.stderr
      const flags = ['eacces', 'badarg', 'epmd', 'hostname', 'BOOT FAILED', 'cookie', 'Failed to create', 'inet_gethost', 'not found', 'permission', 'timeout'].filter(word => logs.includes(word))
      assert.fail('Isolated RabbitMQ not ready: ' + JSON.stringify({ status: driver.backup.inspect(id).State.Status, flags }))
    }
    queuesEmpty(driver, id)
  } finally {
    assert.equal(driver.backup.inspect(id).Config.Labels['pizza.restore-queues-test'], owner)
    run(['rm', '-f', '-v', id], { discardOutput: true })
  }
})
