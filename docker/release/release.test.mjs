import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { composeEnvironment, create, save, validate } from './manifest.mjs'

// Public fixtures only. No local env files, Docker daemon or Registry are used.
const source = {
  CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123',
  PHP_IMAGE: `registry.example.test/team/pizza/php@sha256:${'b'.repeat(64)}`,
  NGINX_IMAGE: `registry.example.test/team/pizza/nginx@sha256:${'c'.repeat(64)}`,
}
const root = fileURLToPath(new URL('../../', import.meta.url))

test('manifest allowlist excludes secrets; env output contains only digest references', () => {
  const manifest = create({ ...source, APP_KEY: 'secret-canary', CI_REGISTRY_PASSWORD: 'secret-canary' })
  assert.equal(JSON.stringify(manifest).includes('secret-canary'), false)
  assert.deepEqual(manifest.deployment_config, { version: 1, git_sha: source.CI_COMMIT_SHA })
  assert.equal(composeEnvironment(manifest), `PHP_IMAGE=${source.PHP_IMAGE}\nNGINX_IMAGE=${source.NGINX_IMAGE}\n`)
})

test('rejects tags, local IDs, credentials, mismatched repositories and extra fields', () => {
  for (const reference of [
    'registry.example.test/team/pizza/php:123', `sha256:${'b'.repeat(64)}`,
    source.PHP_IMAGE.replace('registry.', 'user:password@registry.'),
    source.PHP_IMAGE.replace('/php@', '/nginx@'), `${source.PHP_IMAGE}\n`,
    source.PHP_IMAGE.replace('/team/', '/../'), `${source.PHP_IMAGE}\nAPP_KEY=secret`,
  ]) assert.throws(() => create({ ...source, PHP_IMAGE: reference }))
  assert.throws(() => create({ ...source, NGINX_IMAGE: source.NGINX_IMAGE.replace('/team/', '/other/') }))
  for (const change of [
    { schema_version: 2 }, { git_sha: 'unknown' }, { pipeline_id: 123 },
    { pipeline_id: '123\n' }, { pipeline_id: '0' }, { APP_KEY: 'secret' },
    { deployment_config: { version: 1, git_sha: 'd'.repeat(40) } },
    { images: { php: source.PHP_IMAGE, nginx: source.NGINX_IMAGE, password: 'secret' } },
  ]) assert.throws(() => validate({ ...create(source), ...change }))
})

test('exclusive manifest creation preserves existing files and CLI errors reveal no input', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pizza-release-'))
  try {
    const file = join(directory, 'release.json')
    save(file, create(source))
    const original = readFileSync(file, 'utf8')
    assert.throws(() => save(file, create({ ...source, CI_PIPELINE_ID: '124' })))
    assert.equal(readFileSync(file, 'utf8'), original)
    const cli = (...args) => spawnSync(process.execPath, ['docker/release/manifest.mjs', ...args], {
      cwd: root, encoding: 'utf8', env: { ...source },
    })
    assert.equal(cli('validate', file).status, 0)
    assert.equal(cli('env', file).stdout, composeEnvironment(create(source)))
    assert.equal(cli('create', file).status, 1)
    const other = join(directory, 'new.json')
    assert.equal(cli('create', other).status, 0)
    assert.equal(readFileSync(other, 'utf8'), original)
    writeFileSync(file, '{"secret-canary":')
    const invalid = cli('env', file)
    assert.equal(invalid.status, 1)
    assert.equal(invalid.stdout, '')
    assert.equal(invalid.stderr.includes('secret-canary'), false)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('env file publication is complete, exclusive and cleans temporary files on failure', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pizza-release-export-'))
  try {
    const file = join(directory, 'release.json')
    const output = join(directory, 'release.env')
    const cli = (...args) => spawnSync(process.execPath, ['docker/release/manifest.mjs', ...args], {
      cwd: root, encoding: 'utf8', env: { ...source },
    })
    writeFileSync(file, '{invalid')
    assert.equal(cli('export-env', file, output).status, 1)
    assert.equal(existsSync(output), false)
    assert.deepEqual(readdirSync(directory), ['release.json'])
    save(join(directory, 'valid.json'), create(source))
    const valid = join(directory, 'valid.json')
    assert.equal(cli('export-env', valid, output).status, 0)
    assert.equal(readFileSync(output, 'utf8'), composeEnvironment(create(source)))
    assert.equal(statSync(output).mode & 0o777, 0o600)
    const before = readdirSync(directory).sort()
    const original = readFileSync(output, 'utf8')
    assert.equal(cli('export-env', valid, output).status, 1)
    assert.equal(readFileSync(output, 'utf8'), original)
    assert.deepEqual(readdirSync(directory).sort(), before)
    // A dangling destination symlink must not redirect publication elsewhere.
    const link = join(directory, 'link.env')
    const missing = join(directory, 'missing.env')
    symlinkSync(missing, link)
    const withLink = readdirSync(directory).sort()
    assert.equal(cli('export-env', valid, link).status, 1)
    assert.equal(existsSync(missing), false)
    assert.deepEqual(readdirSync(directory).sort(), withLink)
    assert.equal(cli('export-env', valid, join(directory, 'absent', 'release.env')).status, 1)
    for (const args of [['export-env', valid], ['export-env', valid, output, 'extra']]) {
      assert.equal(cli(...args).status, 1)
    }
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('documented shell scenarios stop on each mandatory command failure', () => {
  const readme = readFileSync(join(root, 'README.md'), 'utf8')
  function scenario(label) {
    const block = readme.slice(readme.indexOf(label)).match(/```bash\r?\n([\s\S]*?)```/)
    assert.ok(block, `Missing README scenario: ${label}`)
    return block[1].replaceAll('\r\n', '\n')
  }
  const fresh = scenario('Создание нового manifest:')
  const existing = scenario('Проверка и экспорт уже существующего manifest')
  const directory = mkdtempSync(join(tmpdir(), 'pizza-release-sequence-'))
  try {
    const file = join(directory, 'release.json')
    const output = join(directory, 'release.env')
    const env = {
      PATH: process.env.PATH, ...source, RELEASE_MANIFEST: file, RELEASE_ENV: output,
    }
    const run = (block, overrides = {}) => spawnSync('sh', ['-c', block], {
      cwd: root, encoding: 'utf8', env: { ...env, ...overrides },
    })
    save(file, create(source))
    const original = readFileSync(file, 'utf8')
    // Existing manifest creation fails: no old release is exported.
    assert.equal(run(fresh).status, 1)
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.equal(existsSync(output), false)
    writeFileSync(file, '{invalid')
    assert.equal(run(existing).status, 1)
    assert.equal(existsSync(output), false)
    const newFile = join(directory, 'new.json')
    assert.equal(run(fresh, { RELEASE_MANIFEST: newFile }).status, 0)
    assert.equal(readFileSync(output, 'utf8'), composeEnvironment(create(source)))
    const anotherOutput = join(directory, 'another.env')
    assert.equal(run(existing, { RELEASE_MANIFEST: newFile, RELEASE_ENV: anotherOutput }).status, 0)
    assert.equal(readFileSync(anotherOutput, 'utf8'), readFileSync(output, 'utf8'))
    assert.equal(run(existing, { RELEASE_MANIFEST: newFile }).status, 1)

    // Fault injection exercises the exact README blocks without executing the
    // real commands. The marker proves no subsequent mandatory command ran.
    const shim = join(directory, 'node')
    const calls = join(directory, 'calls')
    writeFileSync(shim, '#!/bin/sh\nprintf "%s\\n" "$2" >> "$AUDIT_CALLS"\n[ "$2" != "$AUDIT_FAIL" ] || exit 42\n')
    chmodSync(shim, 0o700)
    for (const [block, commands] of [[fresh, ['create', 'validate', 'export-env']], [existing, ['validate', 'export-env']]]) {
      for (let index = 0; index < commands.length; index++) {
        writeFileSync(calls, '')
        const result = run(block, {
          PATH: `${directory}:${process.env.PATH}`, AUDIT_CALLS: calls, AUDIT_FAIL: commands[index],
        })
        assert.equal(result.status, 42)
        assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), commands.slice(0, index + 1))
      }
    }
    assert.notEqual(run(fresh, { RELEASE_ENV: '' }).status, 0)
  } finally {
    rmSync(directory, { recursive: true })
  }
})

test('release Compose removes builds/frontend and preserves production runtime configuration', () => {
  const env = {
    PATH: process.env.PATH, ...source, COMPOSE_PROJECT_NAME: 'pizza-release-check',
    APP_KEY: 'public-test-only', JWT_SECRET: 'public-test-only',
    POSTGRES_DB: 'test', POSTGRES_USER: 'test', POSTGRES_PASSWORD: 'public-test-only',
    DB_CONNECTION: 'pgsql', DB_HOST: 'postgres', DB_PORT: '5432',
    DB_DATABASE: 'test', DB_USERNAME: 'test', DB_PASSWORD: 'public-test-only',
    REDIS_PASSWORD: 'public-test-only', RABBITMQ_USER: 'test', RABBITMQ_PASSWORD: 'public-test-only',
    MINIO_ROOT_USER: 'test', MINIO_ROOT_PASSWORD: 'public-test-only', MINIO_BUCKET: 'reports',
    NGINX_PORT: '8080', PRODUCTS_CACHE_TTL: '3600', POSTGRES_PORT: '5432', REDIS_PORT: '6379',
    RABBITMQ_PORT: '5672', RABBITMQ_MANAGEMENT_PORT: '15672', MINIO_PORT: '9000', MINIO_CONSOLE_PORT: '9001',
  }
  function compose(release, overrides = {}, cwd = root) {
    return spawnSync('docker', [
      'compose', '--env-file', '/dev/null', '--profile', '*', '-f', 'docker-compose.yml',
      '-f', 'docker-compose.prod.yml', ...(release ? ['-f', 'docker-compose.release.yml'] : []),
      'config', '--format', 'json',
    ], { cwd, env: { ...env, ...overrides }, encoding: 'utf8' })
  }
  const original = compose(false)
  const result = compose(true)
  assert.equal(original.status, 0, original.stderr)
  assert.equal(result.status, 0, result.stderr)
  const base = JSON.parse(original.stdout)
  const release = JSON.parse(result.stdout)
  assert.deepEqual(release.services['outbox-worker'].command, ['php', 'artisan', 'outbox:process', '--worker'])
  assert.deepEqual(release.services['report-scheduler'].command, ['php', '/usr/local/bin/scheduler.php'])
  for (const service of ['outbox-worker', 'report-scheduler']) {
    assert.equal(release.services[service].stop_grace_period, '1m10s')
    assert.equal(Object.hasOwn(release.services[service], 'stop_signal'), false)
  }
  assert.equal(Object.hasOwn(release.services, 'frontend'), false)
  const expected = structuredClone(base)
  delete expected.services.frontend
  for (const service of ['php', 'report-worker', 'outbox-worker', 'report-scheduler', 'nginx']) {
    delete expected.services[service].build
    expected.services[service].image = service === 'nginx' ? source.NGINX_IMAGE : source.PHP_IMAGE
    assert.equal(release.services[service].volumes?.length || 0, 0)
  }
  assert.deepEqual(release, expected)
  assert.ok(Object.values(release.services).every(service => !service.build))
  assert.equal(compose(true, { PHP_IMAGE: '' }).status, 1)
  assert.equal(compose(true, { NGINX_IMAGE: '' }).status, 1)
  // Only the Compose bundle is present: no app/, frontend/, Dockerfiles or source mounts.
  const bundle = mkdtempSync(join(tmpdir(), 'pizza-release-bundle-'))
  try {
    for (const file of ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.release.yml']) {
      copyFileSync(join(root, file), join(bundle, file))
    }
    const standalone = compose(true, {}, bundle)
    assert.equal(standalone.status, 0, standalone.stderr)
    assert.deepEqual(JSON.parse(standalone.stdout), release)
  } finally {
    rmSync(bundle, { recursive: true })
  }
})
