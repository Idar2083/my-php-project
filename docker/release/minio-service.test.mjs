import assert from 'node:assert/strict'
import fs from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import test from 'node:test'
import { DockerBackup } from './backup-docker.mjs'

function fixture(run) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-minio-service-'))
  try {
    const docker = join(directory, 'docker')
    fs.writeFileSync(docker, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
    const driver = new DockerBackup({ utility_image: 'test-utility-not-executed' })
    driver.env.PATH = directory
    const calls = [], report = { buckets: 1, versions: 2, bytes: 3, content_sha256: 'a'.repeat(64) }
    driver.inspect = () => ({ Config: { Labels: { 'pizza.backup-test': 'owner' } }, State: { Running: true } })
    driver.run = (args, options) => {
      calls.push({ args, options })
      if (args[0] === 'create') return 'owned-restored-container'
      if (args[0] === 'run') return JSON.stringify(report)
      return ''
    }
    run({ driver, calls, report, metadata: { minio: { image: 'test-minio-not-executed' } } })
  } finally { fs.rmSync(directory, { recursive: true }) }
}

test('MinIO service check uses only the restored volume and loopback namespace with ephemeral env credentials', () => fixture(({ driver, calls, report, metadata }) => {
  assert.deepEqual(driver.verifyRestoredMinio('owned-volume', metadata, 'owner'), report)
  const create = calls.find(call => call.args[0] === 'create')
  const probe = calls.find(call => call.args[0] === 'run')
  assert.ok(create.args.includes('--network=none'))
  assert.ok(create.args.includes('type=volume,src=owned-volume,dst=/data'))
  assert.ok(create.args.includes(metadata.minio.image))
  assert.ok(probe.args.includes('--network=container:owned-restored-container'))
  assert.deepEqual(probe.options.environment, create.options.environment)
  for (const value of Object.values(create.options.environment)) {
    assert.equal([...create.args, ...probe.args].some(arg => arg.includes(value)), false)
  }
  assert.deepEqual(calls.at(-1).args, ['rm', '-f', 'owned-restored-container'])
}))

for (const failure of ['start', 'probe', 'malformed-report', 'crashed-server']) {
  test(`MinIO ${failure} never reports success and cleans the owned restored container`, () => fixture(({ driver, calls, metadata }) => {
    const original = driver.run
    driver.run = (args, options) => {
      if ((failure === 'start' && args[0] === 'start') || (failure === 'probe' && args[0] === 'run')) {
        calls.push({ args, options })
        throw new Error('controlled failure')
      }
      if (failure === 'malformed-report' && args[0] === 'run') return '{broken'
      return original(args, options)
    }
    if (failure === 'crashed-server') {
      fs.writeFileSync(join(driver.env.PATH, 'docker'), '#!/bin/sh\nexit 1\n', { mode: 0o700 })
      driver.inspect = () => ({ Config: { Labels: { 'pizza.backup-test': 'owner' } }, State: { Running: false } })
    }
    assert.throws(() => driver.verifyRestoredMinio('owned-volume', metadata, 'owner'))
    assert.deepEqual(calls.at(-1).args, ['rm', '-f', 'owned-restored-container'])
  }))
}

test('failed create never removes any existing container', () => fixture(({ driver, calls, metadata }) => {
  driver.run = args => { calls.push({ args }); throw new Error('create failed') }
  assert.throws(() => driver.verifyRestoredMinio('owned-volume', metadata, 'owner'))
  assert.deepEqual(calls.map(call => call.args[0]), ['create'])
}))

for (const invalid of [{ buckets: -1 }, { versions: 1.5 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { content_sha256: 'invalid' }]) {
  test(`invalid MinIO report ${Object.keys(invalid)[0]} fails and cleans the restored container`, () => fixture(({ driver, calls, report, metadata }) => {
    Object.assign(report, invalid)
    assert.throws(() => driver.verifyRestoredMinio('owned-volume', metadata, 'owner'))
    assert.deepEqual(calls.at(-1).args, ['rm', '-f', 'owned-restored-container'])
  }))
}

test('cleanup refuses to remove a container with a foreign ownership label', () => fixture(({ driver, calls, metadata }) => {
  driver.inspect = () => ({ Config: { Labels: { 'pizza.backup-test': 'foreign-owner' } } })
  assert.throws(() => driver.verifyRestoredMinio('owned-volume', metadata, 'owner'))
  assert.equal(calls.some(call => call.args[0] === 'rm'), false)
}))
