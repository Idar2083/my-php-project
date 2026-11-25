import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'
import test from 'node:test'
import { DockerBackup } from './backup-docker.mjs'
import { descriptor, ReleaseRuntime } from './release-runtime.mjs'
import { jsonHash } from './coordinator.mjs'

// Runtime/Compose contract test only: these PHP processes simulate infrastructure
// and a successful migration, never bootstrap Laravel or use a real database.
test('isolated Docker preserves frozen env, records creation/start, observes migration exit and cleans its task', {
  skip: process.env.RELEASE_RUNTIME_DOCKER_TEST !== '1', timeout: 90000,
}, () => {
  const owner = randomUUID(), project = 'pizza-launch-test-' + owner
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-launch-docker-'))
  const backup = new DockerBackup({ project })
  const run = backup.run.bind(backup)
  const network = project + '_default'
  let networkCreated = false
  try {
    const image = run(['image', 'inspect', process.env.RELEASE_TEST_PHP_IMAGE || 'pizza-background-check:audit-eb7383641a1a-9e67bdf247c5', '--format', '{{.Id}}'])
    const networkId = run(['network', 'create', '--label', `pizza.release-runtime-test=${owner}`, network])
    networkCreated = true
    const source = {}
    for (const name of ['postgres', 'redis', 'rabbitmq', 'php']) {
      const id = run(['create', '--pull=never', '--name', project + '-' + name + '-1', '--network', network,
        '--label', `pizza.release-runtime-test=${owner}`, '--label', `com.docker.compose.project=${project}`, '--label', `com.docker.compose.service=${name}`, '--label', 'com.docker.compose.container-number=1',
        '--label', 'com.docker.compose.oneoff=False', '--label', 'com.docker.compose.config-hash=fixture-old',
        '--health-cmd', 'php -r "exit(0);"', '--health-interval', '1s', '--health-timeout', '2s',
        '--entrypoint', 'php', image, '-r', 'sleep(120);'])
      if (name !== 'php') run(['start', id])
      source[name] = descriptor(backup.inspect(id))
    }
    const operation = 'a'.repeat(64)
    const service = { image, entrypoint: ['php'], command: ['-r', 'sleep(120);'], restart: 'no',
      environment: { PUBLIC_FIXTURE: 'dollar$$value' }, networks: { default: null },
      labels: { 'pizza.release-operation': operation, 'pizza.release-runtime-test': owner },
      healthcheck: { test: ['CMD', 'php', '-r', 'exit(0);'], interval: '1s', timeout: '2s', retries: 5 } }
    const model = { name: project, services: { php: service,
      'release-migration': { ...service, command: ['-r', 'exit(0);'], healthcheck: { disable: true } } },
      networks: { default: { external: true, name: network } } }
    fs.writeFileSync(join(directory, 'compose.json'), JSON.stringify(model), { mode: 0o600 })
    const runtime = new ReleaseRuntime({ backup }, directory, { project, operation_id: operation,
      bundle: directory, compose_sha256: jsonHash(model), images: { php: image, nginx: image }, source, networks: { [network]: networkId } })
    runtime.migrate()
    const task = runtime.read('migration-completed')
    runtime.migrate()
    assert.deepEqual(runtime.read('migration-completed'), task)
    runtime.create('php');runtime.start('php');runtime.healthy(['php'])
    const item = runtime.guard().php
    assert.ok(item.Config.Env.includes('PUBLIC_FIXTURE=dollar$value'))
    assert.equal(item.Image, image)
    runtime.start('php')
    runtime.committed = true
    runtime.cleanup()
    runtime.migrationCompleted()
    assert.equal(runtime.guard()['release-migration'], undefined)
  } finally {
    const ids = run(['ps', '-aq', '--filter', `label=pizza.release-runtime-test=${owner}`]).split(/\s+/).filter(Boolean)
    for (const id of ids) {
      assert.equal(backup.inspect(id).Config.Labels['pizza.release-runtime-test'], owner)
      run(['rm', '-f', id])
    }
    if (networkCreated) {
      const info = JSON.parse(run(['network', 'inspect', network]))[0]
      assert.equal(info.Labels['pizza.release-runtime-test'], owner)
      run(['network', 'rm', network])
    }
    fs.rmSync(directory, { recursive: true })
  }
})

test('production worker health probes match the actual PID 1 command and reject a different role', {
  skip: process.env.RELEASE_RUNTIME_DOCKER_TEST !== '1', timeout: 60000,
}, () => {
  const owner = randomUUID(), backup = new DockerBackup({})
  const production = fs.readFileSync(new URL('../../docker-compose.prod.yml', import.meta.url), 'utf8')
  const roles = [
    ['report-worker', 'artisan', 'queue:work rabbitmq'],
    ['outbox-worker', 'artisan', 'outbox:process --worker'],
    ['report-scheduler', '/usr/local/bin/scheduler.php', ''],
  ]
  const probes = roles.map(([name]) => {
    const section = production.split(`  ${name}:`)[1]
    const match = section.match(/        - '(exit\(str_replace[^\r\n]*)'/)
    assert.ok(match, 'Missing configured PID 1 health probe')
    return match[1]
  })
  const image = backup.run(['image', 'inspect', process.env.RELEASE_TEST_PHP_IMAGE || 'pizza-background-check:audit-eb7383641a1a-9e67bdf247c5', '--format', '{{.Id}}'])
  for (const [index, [name, path, args]] of roles.entries()) {
    const id = backup.run(['create', '--pull=never', '--network=none', '--user=0', '--label', `pizza.release-runtime-test=${owner}`,
      '--entrypoint', 'sh', image, '-ec', `cd /tmp; printf '%s' '<?php sleep(120);' > ${path}; exec php ${path}${args ? ' ' + args : ''}`])
    try {
      backup.run(['start', id])
      let ready = false
      for (let count = 0; count < 20; count++) {
        try { backup.run(['exec', id, 'php', '-r', probes[index]]);ready = true;break } catch {}
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
      assert.ok(ready, `Configured ${name} health probe did not match PHP PID 1`)
      assert.throws(() => backup.run(['exec', id, 'php', '-r', probes[(index + 1) % roles.length]]))
    } finally {
      assert.equal(backup.inspect(id).Config.Labels['pizza.release-runtime-test'], owner)
      backup.run(['rm', '-f', id])
    }
  }
})
