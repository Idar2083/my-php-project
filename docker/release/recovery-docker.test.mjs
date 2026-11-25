import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { DockerCoordinator, writerOrder } from './coordinator-docker.mjs'
import { applicationServices, infrastructureServices, descriptor } from './release-runtime.mjs'
import { RecoveryRuntime } from './recovery-runtime.mjs'

// Docker lifecycle contract with inert PHP PID 1 fixtures. No Laravel, Registry,
// database restore, application data, host ports or production network.
test('isolated Docker recovery stops pinned writers, restarts retained containers once and detects substitution', {
  skip: process.env.RELEASE_RUNTIME_DOCKER_TEST !== '1', timeout: 90000,
}, () => {
  const owner = randomUUID(), project = 'pizza-recovery-test-' + owner
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-recovery-docker-'))
  const driver = new DockerCoordinator({ project }), run = driver.backup.run.bind(driver.backup)
  const network = project + '_default'
  let networkCreated = false
  try {
    const image = run(['image', 'inspect', process.env.RELEASE_TEST_PHP_IMAGE || 'pizza-background-check:audit-eb7383641a1a-9e67bdf247c5', '--format', '{{.Id}}'])
    const networkId = run(['network', 'create', '--label', `pizza.recovery-test=${owner}`, network]);networkCreated = true
    const names = [...infrastructureServices, ...applicationServices]
    for (const name of names) {
      const id = run(['create', '--pull=never', '--network', network,
        '--label', `pizza.recovery-test=${owner}`, '--label', `com.docker.compose.project=${project}`, '--label', `com.docker.compose.service=${name}`,
        '--health-cmd', 'php -r "exit(0);"', '--health-interval', '1s', '--health-timeout', '2s', '--entrypoint', 'php', image,
        '-r', 'pcntl_async_signals(true);pcntl_signal(SIGTERM,fn()=>exit(0));pcntl_signal(SIGQUIT,fn()=>exit(0));while(true){sleep(1);}'])
      run(['start', id])
    }
    const inventory = () => Object.fromEntries(run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).split(/\s+/).filter(Boolean).map(id => {
      const item = driver.backup.inspect(id);return [item.Config.Labels['com.docker.compose.service'], descriptor(item)]
    }))
    const manualDirectory = join(directory, 'manual');fs.mkdirSync(manualDirectory)
    const networks = { [network]: networkId }
    const manual = new RecoveryRuntime(driver, manualDirectory, { project, mode: 'manual', source: inventory(), networks })
    manual.healthy(names)
    manual.stopWriters();manual.stopWriters()
    const stopped = manual.guard()
    for (const name of writerOrder.filter(name => name !== 'minio-init')) assert.equal(stopped[name].State.Running, false)
    assert.equal(stopped.postgres.State.Running, true)
    const rollbackDirectory = join(directory, 'rollback');fs.mkdirSync(rollbackDirectory)
    const rollback = new RecoveryRuntime(driver, rollbackDirectory, { project, mode: 'rollback', source: inventory(), networks })
    // Dependency/API integration is covered with fake adapters; this fixture
    // deliberately exercises only the real start/health/stop/inspect contract.
    rollback.dependencies = () => rollback.healthy([...infrastructureServices, 'php'])
    rollback.health = () => rollback.healthy(names)
    rollback.restoreApplication()
    const started = Object.fromEntries(names.map(name => [name, descriptor(rollback.guard()[name])]))
    rollback.restoreApplication()
    for (const name of names) assert.deepEqual(descriptor(rollback.guard()[name]), started[name])
    run(['update', '--restart=always', started.php.id])
    assert.throws(() => rollback.guard())
  } finally {
    const ids = run(['ps', '-aq', '--filter', `label=pizza.recovery-test=${owner}`]).split(/\s+/).filter(Boolean)
    for (const id of ids) {
      assert.equal(driver.backup.inspect(id).Config.Labels['pizza.recovery-test'], owner)
      run(['rm', '-f', id])
    }
    if (networkCreated) {
      assert.equal(JSON.parse(run(['network', 'inspect', network]))[0].Labels['pizza.recovery-test'], owner)
      run(['network', 'rm', network])
    }
    fs.rmSync(directory, { recursive: true })
  }
})
