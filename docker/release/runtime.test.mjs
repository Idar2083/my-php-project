import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { createRuntime } from './create-runtime.mjs'
import { create } from './manifest.mjs'
import { checkCompose, initialState } from './state.mjs'

const root = new URL('../../', import.meta.url)
const manifest = create({ CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '1',
  PHP_IMAGE: 'registry.example.test/pizza/php@sha256:' + 'b'.repeat(64),
  NGINX_IMAGE: 'registry.example.test/pizza/nginx@sha256:' + 'c'.repeat(64) })

function fixture(run) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-runtime-test-'))
  try { run(directory) } finally { fs.rmSync(directory, { recursive: true }) }
}

test('private first-install runtime passes the actual release validator and binds only loopback', () => fixture(directory => {
  assert.equal(createRuntime(directory), true)
  const runtime = join(directory, 'runtime.env')
  assert.equal(fs.statSync(runtime).mode & 0o777, 0o600)
  const contents = fs.readFileSync(runtime, 'utf8')
  for (const name of ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.release.yml']) {
    fs.copyFileSync(new URL(name, root), join(directory, name))
  }
  fs.writeFileSync(join(directory, '.env'), '')
  const model = checkCompose(initialState('pizza-runtime-test'), manifest, directory, runtime)
  assert.equal(model.services.nginx.ports.length, 1)
  assert.equal(model.services.nginx.ports[0].host_ip, '127.0.0.1')
  assert.equal(model.services.nginx.ports[0].published, '8080')
  assert.equal(model.services.nginx.ports[0].target, 80)
  const env = model.services.php.environment
  assert.equal(env.APP_URL, 'http://127.0.0.1:8080')
  assert.ok(/^base64:[A-Za-z0-9+/]{43}=$/.test(env.APP_KEY))
  assert.ok(/^[a-f0-9]{64}$/.test(env.JWT_SECRET))
  assert.ok(env.DB_PASSWORD === model.services.postgres.environment.POSTGRES_PASSWORD)
  assert.equal(env.DB_DATABASE, model.services.postgres.environment.POSTGRES_DB)
  assert.equal(env.DB_USERNAME, model.services.postgres.environment.POSTGRES_USER)
  assert.ok(env.AWS_ACCESS_KEY_ID === model.services.minio.environment.MINIO_ROOT_USER)
  assert.ok(env.AWS_SECRET_ACCESS_KEY === model.services.minio.environment.MINIO_ROOT_PASSWORD)
  assert.equal(env.AWS_BUCKET, model.services['minio-init'].environment.MINIO_BUCKET)
  assert.ok(env.REDIS_PASSWORD === model.services.redis.environment.REDIS_PASSWORD)
  assert.ok(env.RABBITMQ_PASSWORD === model.services.rabbitmq.environment.RABBITMQ_DEFAULT_PASS)
  for (const service of Object.values(model.services)) {
    assert.ok(!service.build && !(service.volumes || []).some(mount => mount.type === 'bind'))
  }
  for (const name of ['postgres', 'redis', 'rabbitmq', 'minio']) assert.equal(model.services[name].ports?.length || 0, 0)
  // Retries retain identity keys and credentials even if a different port is requested.
  assert.equal(createRuntime(directory, '9090'), false)
  assert.ok(fs.readFileSync(runtime, 'utf8') === contents)
  assert.ok(!fs.readdirSync(directory).some(name => name.startsWith('.runtime-')))
}))

test('runtime preparation rejects unsafe permissions, symlinks and invalid ports without overwriting', () => fixture(directory => {
  const runtime = join(directory, 'runtime.env'), absent = join(directory, 'absent')
  for (const port of ['', '0', '65536', '127.0.0.1:8080', '8080\n', '08080']) {
    assert.throws(() => createRuntime(directory, port))
    assert.equal(fs.existsSync(runtime), false)
  }
  fs.chmodSync(directory, 0o755)
  assert.throws(() => createRuntime(directory))
  fs.chmodSync(directory, 0o700)
  fs.symlinkSync(absent, runtime)
  assert.throws(() => createRuntime(directory))
  assert.equal(fs.existsSync(absent), false)
  fs.unlinkSync(runtime)
  fs.writeFileSync(runtime, 'PRIVATE_CANARY=preserved\n', { mode: 0o644 })
  assert.throws(() => createRuntime(directory))
  assert.ok(fs.readFileSync(runtime, 'utf8') === 'PRIVATE_CANARY=preserved\n')
  const cli = spawnSync(process.execPath, [new URL('./create-runtime.mjs', import.meta.url).pathname, directory], { encoding: 'utf8' })
  assert.equal(cli.status, 1)
  assert.ok(!(cli.stdout + cli.stderr).includes('PRIVATE_CANARY'))
}))

test('failed runtime publication leaves no partial destination or temporary secret files', () => fixture(directory => {
  const link = fs.linkSync
  try {
    fs.linkSync = () => { throw new Error('injected publication failure') }
    assert.throws(() => createRuntime(directory))
    assert.deepEqual(fs.readdirSync(directory), [])
  } finally { fs.linkSync = link }
}))

test('CLI creates a private runtime without printing secrets and preserves it on retry', () => fixture(directory => {
  const cli = () => spawnSync(process.execPath, [new URL('./create-runtime.mjs', import.meta.url).pathname, directory], { encoding: 'utf8' })
  const first = cli()
  assert.equal(first.status, 0)
  assert.equal(first.stdout, 'Private runtime file created.\n')
  assert.equal(first.stderr, '')
  const runtime = join(directory, 'runtime.env')
  const before = fs.readFileSync(runtime)
  const stat = fs.statSync(runtime)
  assert.equal(stat.mode & 0o777, 0o600)
  const retry = cli()
  assert.equal(retry.status, 0)
  assert.equal(retry.stdout, 'Existing private runtime file preserved; review its configuration separately.\n')
  assert.equal(retry.stderr, '')
  assert.deepEqual(fs.readFileSync(runtime), before)
  assert.equal(fs.statSync(runtime).ino, stat.ino)
  assert.deepEqual(fs.readdirSync(directory), ['runtime.env'])
}))
