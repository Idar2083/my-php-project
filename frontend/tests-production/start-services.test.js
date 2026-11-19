import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { startServices } from './start-services.js'

test('successful startup performs no diagnostics', () => {
  startServices(() => {}, () => assert.fail('unexpected Compose query'), () => assert.fail('unexpected Docker query'))
})

test('missing diagnostics preserve the original error', () => {
  const failure = new Error('original failure')
  const output = []
  assert.throws(() => startServices(() => { throw failure }, () => { throw new Error('secret') },
    () => assert.fail('unexpected Docker query'), value => output.push(value)), error => error === failure)
  assert.deepEqual(output, ['RabbitMQ diagnostics unavailable.'])
})

test('runner diagnoses failed Compose startup before cleanup and preserves its exit code', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pizza-start-services-test-'))
  try {
    const fixture = join(directory, 'docker')
    const calls = join(directory, 'calls')
    writeFileSync(fixture, `#!/usr/bin/env node
const fs = require('node:fs');
const a = process.argv.slice(2);
const log = command => fs.appendFileSync(process.env.FIXTURE_CALLS, command + '\\n');
const say = value => console.log(value);
if (a[0] === 'inspect') {
  log('inspect');
  say(JSON.stringify('sha256:' + 'a'.repeat(64)));
  say('2');
  say(JSON.stringify({ Status: 'running', OOMKilled: false, ExitCode: 0, Health: { Status: 'unhealthy', FailingStreak: 10,
    Log: [{ ExitCode: -1, Output: 'Health check exceeded timeout; probe-secret' }] } }));
}
if (a[0] === 'compose') {
  if (a.includes('ps')) { log('ps'); say('a'.repeat(64)); }
  if (a.includes('logs')) { log('logs'); say('BOOT FAILED broker-secret'); }
  if (a.includes('up')) { log('up'); process.exitCode = 23; }
  if (a.includes('down')) { log('down'); process.exitCode = 41; }
  if (a.includes('config')) {
    for (const key of ['APP_KEY', 'JWT_SECRET']) if (process.env[key] === '') { console.error(key); process.exit(1); }
    if (a.includes('--format')) say(JSON.stringify({ services: {
      php: { user: 'www-data', build: { target: 'prod' } },
      nginx: { build: { target: 'prod' }, ports: [{ host_ip: '127.0.0.1' }] },
      postgres: {}, redis: {}, rabbitmq: {}, minio: {},
    } }));
  }
}
`, { mode: 0o700 })
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./run.js', import.meta.url))], {
      env: { ...process.env, PATH: directory + delimiter + process.env.PATH, FIXTURE_CALLS: calls,
        PRODUCTION_CHECK_NETWORK: '', PRODUCTION_EXPORT_IMAGES: '', PRODUCTION_CHECK_PROJECT: '' },
      encoding: 'utf8', timeout: 20000,
    })
    assert.equal(result.status, 23, result.stderr)
    assert.equal(readFileSync(calls, 'utf8'), 'up\nps\ninspect\nlogs\ndown\n')
    assert.match(result.stderr, /"restartCount":2/)
    assert.match(result.stderr, /"exitCode":-1,"signals":\["timeout"\]/)
    assert.match(result.stderr, /RabbitMQ log summary .*boot_failed/)
    assert.match(result.stderr, /cleanup failed after the original failure/)
    assert.doesNotMatch(result.stderr + result.stdout, /probe-secret|broker-secret/)
  } finally {
    rmSync(directory, { recursive: true })
  }
})
