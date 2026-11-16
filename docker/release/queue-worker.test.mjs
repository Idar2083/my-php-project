import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { exerciseWorker } from './queue-worker-test-support.mjs'

const fixture = fileURLToPath(new URL('./queue-worker-fixture.php', import.meta.url))
const autoload = fileURLToPath(new URL('../../app/vendor/autoload.php', import.meta.url))

for (const [signal, number] of [['SIGQUIT', 3], ['SIGTERM', 15]]) {
  test(`Laravel Worker completes its job and stops on ${signal}`, { timeout: 15000 }, async () => {
    const child = spawn('php', [fixture, autoload], {
      env: { PATH: process.env.PATH }, stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      await exerciseWorker(child, number, () => { assert.equal(child.kill(signal), true) })
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
}

test('fixture fails closed when pcntl is unavailable', () => {
  const result = spawnSync('php', ['-d', 'disable_functions=pcntl_async_signals', fixture, autoload], {
    encoding: 'utf8', env: { PATH: process.env.PATH },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, 'pcntl is required for the queue signal test.\n')
})

test('worker entrypoint refuses missing pcntl before topology setup or queue access', () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-worker-entrypoint-'))
  try {
    const php = join(directory, 'php')
    fs.writeFileSync(php, '#!/bin/sh\n[ "$1" = -r ] || exit 99\nexit 42\n')
    fs.chmodSync(php, 0o700)
    const entrypoint = fileURLToPath(new URL('../php/entrypoint.worker.sh', import.meta.url))
    const result = spawnSync('/bin/sh', [entrypoint], { encoding: 'utf8', env: { PATH: directory } })
    assert.equal(result.status, 42)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, '')
  } finally {
    fs.rmSync(directory, { recursive: true })
  }
})
