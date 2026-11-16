import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { create } from './manifest.mjs'

const module = new URL('./bootstrap.mjs', import.meta.url).href
const support = new URL('./release-test-support.mjs', import.meta.url).href
const manifest = create({ CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123', PHP_IMAGE: 'registry.example.test/pizza/php@sha256:' + 'b'.repeat(64), NGINX_IMAGE: 'registry.example.test/pizza/nginx@sha256:' + 'c'.repeat(64) })
const read = directory => JSON.parse(fs.readFileSync(join(directory, 'fixture.json')))
function change(directory, patch) { fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ ...read(directory), ...patch })) }
const state = directory => JSON.parse(fs.readFileSync(join(directory, 'state.json')))
function execute(directory, code = '') {
  return spawnSync('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;exec node --input-type=module -e "$TEST_CODE"'], {
    encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, TEST_DIRECTORY: directory, TEST_CODE: `
      import fs from 'node:fs';
      import {fixtureFailure} from ${JSON.stringify(new URL('./release-test-diagnostics.mjs', import.meta.url).href)};
      import {bootstrapRelease} from ${JSON.stringify(module)};
      import {FakeReleaseDriver} from ${JSON.stringify(support)};
      const directory=process.env.TEST_DIRECTORY, driver=new FakeReleaseDriver(directory+'/fixture.json');
      const manifest=${JSON.stringify(manifest)};
      ${code}
      try {bootstrapRelease(directory,manifest,'unused-bundle',directory+'/runtime.env',directory+'/backup',driver)}
      catch(error) {process.stderr.write(fixtureFailure(error, 'bootstrapRelease'));process.exitCode=1}
    ` },
  })
}
async function fixture(run) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-bootstrap-'))
  try {
    fs.mkdirSync(join(directory, 'backup'), { mode: 0o700 })
    fs.writeFileSync(join(directory, 'runtime.env'), 'RUNTIME_CONTENT_CANARY=public-fixture\n', { mode: 0o600 })
    const env = { APP_ENV: 'production', APP_DEBUG: 'false', APP_URL: 'https://pizza.example.test', CACHE_STORE: 'database',
      DB_CONNECTION: 'pgsql', DB_HOST: 'postgres', DB_PORT: '5432', DB_DATABASE: 'pizza', DB_USERNAME: 'pizza', DB_PASSWORD: 'public-fixture' }
    const names = ['postgres', 'redis', 'rabbitmq', 'minio', 'minio-init', 'php', 'report-worker', 'outbox-worker', 'report-scheduler', 'nginx']
    const compose = { name: 'pizza-backup-test', services: Object.fromEntries(names.map(name => [name, {
      image: name === 'nginx' ? manifest.images.nginx : manifest.images.php,
      restart: name === 'minio-init' ? 'no' : 'unless-stopped',
      environment: name === 'postgres' ? { ...env, POSTGRES_DB: 'pizza', POSTGRES_USER: 'pizza', POSTGRES_PASSWORD: 'public-fixture' } : env,
      healthcheck: { test: ['CMD', 'true'] }, networks: { default: null },
    }])), volumes: { data: { name: 'pizza-backup-test_data' } }, networks: { default: { name: 'pizza-backup-test_default' } } }
    fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ bootstrap: true, compose, containers: {}, writers: [], calls: [], stops: [], counter: 0 }))
    await run(directory)
  } finally { fs.rmSync(directory, { recursive: true }) }
}

test('empty installation uses normal backup/migration/readiness and registers current only at commit; repeat is read-only health', () => fixture(directory => {
  const result = execute(directory)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(state(directory).current, manifest)
  assert.equal(state(directory).previous, null)
  assert.equal(state(directory).operation, null)
  assert.equal(read(directory).containers.php.Config.Env.includes('CACHE_STORE=database'), true)
  const launchFolder = fs.readdirSync(directory).find(name => name.startsWith('launch-'))
  const model = JSON.parse(fs.readFileSync(join(directory, launchFolder, 'compose.json')))
  assert.equal(model.services['release-migration'].environment.CACHE_STORE, 'redis')
  const preparation = JSON.parse(fs.readFileSync(join(directory, 'bootstrap', 'compose.json')))
  for (const name of ['postgres', 'redis', 'rabbitmq', 'minio']) assert.equal(preparation.services[name].restart, 'unless-stopped')
  const calls = read(directory).calls
  assert.ok(calls.indexOf('empty-database') < calls.indexOf('dump'))
  assert.ok(calls.indexOf('restore') < calls.indexOf('migration'))
  assert.ok(calls.indexOf('migration') < calls.indexOf('dependencies'))
  assert.ok(calls.indexOf('dependencies') < calls.indexOf('start:nginx'))
  const bytes = fs.readFileSync(join(directory, 'state.json'), 'utf8')
  change(directory, { calls: [] })
  const retry = execute(directory)
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), bytes)
  assert.equal(read(directory).calls.some(call => /^(pull:|start:|create:|dump|migration|bucket|empty-database)/.test(call)), false)
  for (const file of ['plan.json', 'backup-settings.json']) {
    assert.equal(fs.readFileSync(join(directory, 'bootstrap', file), 'utf8').includes('public-fixture'), false)
    assert.equal(fs.statSync(join(directory, 'bootstrap', file)).mode & 0o777, 0o600)
  }
}))

test('owner-only read access remains a supported runtime permission', () => fixture(directory => {
  fs.chmodSync(join(directory, 'runtime.env'), 0o400)
  const result = execute(directory)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(state(directory).current, manifest)
  assert.equal((result.stdout + result.stderr).includes('RUNTIME_CONTENT_CANARY'), false)
}))

test('bootstrap validates metadata without reading runtime contents', () => fixture(directory => {
  const result = execute(directory, `
    const readFile=fs.readFileSync;
    fs.readFileSync=(path,...args)=>{
      if(path===directory+'/runtime.env')throw new Error('UNEXPECTED_RUNTIME_READ');
      return readFile(path,...args);
    };
  `)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(state(directory).current, manifest)
}))

test('repeat bootstrap revalidates runtime before Compose or Docker calls', () => fixture(directory => {
  const first = execute(directory)
  assert.equal(first.status, 0, first.stderr)
  const before = fs.readFileSync(join(directory, 'state.json'), 'utf8')
  change(directory, { calls: [] })
  const containers = read(directory).containers
  fs.chmodSync(join(directory, 'runtime.env'), 0o644)
  const result = execute(directory, `
    driver.check=()=>{throw new Error('UNEXPECTED_COMPOSE_CALL');};
    try {bootstrapRelease(directory,manifest,'unused-bundle',directory+'/runtime.env',directory+'/backup',driver)}
    catch(error){
      if(error.message!=='BOOTSTRAP_RUNTIME_FILE_UNSAFE')throw error;
      process.stderr.write(error.message+'\\n');process.exit(1);
    }
    process.exit(99);
  `)
  assert.equal(result.status, 1)
  assert.ok(result.stderr.includes('BOOTSTRAP_RUNTIME_FILE_UNSAFE'))
  assert.equal(result.stderr.includes('RUNTIME_CONTENT_CANARY'), false)
  assert.deepEqual(read(directory).calls, [])
  assert.deepEqual(read(directory).containers, containers)
  assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), before)
}))

for (const problem of ['missing', 'symlink', 'directory', 'no-permissions', 'owner-write-only', 'group-readable', 'world-readable', 'other-readable', 'group-writable', 'wrong-owner', 'metadata-error']) {
  test(`bootstrap rejects ${problem} runtime before Compose or Docker mutations`, () => fixture(directory => {
    const runtime = join(directory, 'runtime.env')
    let code = ''
    if (problem === 'missing') fs.unlinkSync(runtime)
    if (problem === 'symlink') {
      fs.renameSync(runtime, join(directory, 'runtime-target'))
      fs.symlinkSync(join(directory, 'runtime-target'), runtime)
    }
    if (problem === 'directory') { fs.unlinkSync(runtime);fs.mkdirSync(runtime) }
    if (problem === 'no-permissions') fs.chmodSync(runtime, 0o000)
    if (problem === 'owner-write-only') fs.chmodSync(runtime, 0o200)
    if (problem === 'group-readable') fs.chmodSync(runtime, 0o640)
    if (problem === 'world-readable') fs.chmodSync(runtime, 0o644)
    if (problem === 'other-readable') fs.chmodSync(runtime, 0o604)
    if (problem === 'group-writable') fs.chmodSync(runtime, 0o620)
    // Faults are local to the child process and this synthetic path. No chown
    // privileges, real runtime file or host account assumptions are required.
    if (['wrong-owner', 'metadata-error'].includes(problem)) code = `
      const lstat=fs.lstatSync;
      fs.lstatSync=(path,...args)=>{
        if(path!==directory+'/runtime.env')return lstat(path,...args);
        ${problem === 'metadata-error' ? "throw new Error('RUNTIME_CONTENT_CANARY');" : 'const stat=lstat(path,...args);stat.uid=process.getuid()+1;return stat;'}
      };
    `
    code += `
      driver.check=()=>{fs.writeFileSync(directory+'/compose-called','unexpected');throw new Error('COMPOSE_CALLED');};
      try {bootstrapRelease(directory,manifest,'unused-bundle',directory+'/runtime.env',directory+'/backup',driver)}
      catch(error){
        if(error.message!=='BOOTSTRAP_RUNTIME_FILE_UNSAFE')throw error;
        process.stderr.write(error.message+'\\n');process.exit(1);
      }
      process.exit(99);
    `
    const result = execute(directory, code)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(result.stderr, 'BOOTSTRAP_RUNTIME_FILE_UNSAFE\n')
    assert.equal((result.stdout + result.stderr).includes('RUNTIME_CONTENT_CANARY'), false)
    assert.equal((result.stdout + result.stderr).includes(runtime), false)
    assert.equal(fs.existsSync(join(directory, 'compose-called')), false)
    assert.deepEqual(read(directory).calls, [])
    assert.deepEqual(read(directory).containers, {})
    assert.equal(fs.existsSync(join(directory, 'state.json')), false)
    assert.equal(fs.existsSync(join(directory, 'bootstrap')), false)
  }))
}

for (const mode of [0o000, 0o200, 0o644]) {
  test(`bootstrap CLI rejects runtime mode ${mode.toString(8)} without exposing paths or contents or invoking Docker`, () => fixture(directory => {
    const manifestPath = join(directory, 'manifest.json')
    fs.writeFileSync(manifestPath, JSON.stringify(manifest))
    fs.chmodSync(join(directory, 'runtime.env'), mode)
    const bin = join(directory, 'bin')
    fs.mkdirSync(bin)
    fs.writeFileSync(join(bin, 'docker'), '#!/bin/sh\ntouch "$(dirname "$0")/docker-called"\nexit 99\n', { mode: 0o700 })
    const result = spawnSync('sh', [fileURLToPath(new URL('./release.sh', import.meta.url)), 'bootstrap', directory,
      manifestPath, 'unused-bundle', join(directory, 'runtime.env'), 'pizza-backup-test', join(directory, 'backup')], {
      encoding: 'utf8', timeout: 5000, env: { PATH: bin + ':' + process.env.PATH },
    })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr, 'Release bootstrap failed: runtime file must be a regular file owned by the current user with owner-read permission and no group or other permissions.\n')
    assert.equal(result.stderr.includes(directory), false)
    assert.equal(result.stderr.includes('RUNTIME_CONTENT_CANARY'), false)
    assert.equal(fs.existsSync(join(bin, 'docker-called')), false)
    assert.equal(fs.existsSync(join(directory, 'state.json')), false)
  }))
}

test('failed first migration remains uncommitted and is never rerun', () => fixture(directory => {
  change(directory, { migration_exit: 42 })
  assert.equal(execute(directory).status, 1)
  assert.equal(state(directory).operation.phase, 'migrating')
  assert.equal(state(directory).current, null)
  assert.equal(read(directory).calls.includes('start:php'), false)
  change(directory, { migration_exit: 0 })
  assert.equal(execute(directory).status, 1)
  assert.equal(read(directory).calls.filter(call => call === 'start:release-migration').length, 1)
}))

test('dependency readiness failure blocks ingress/current and retry reuses the completed migration', () => fixture(directory => {
  change(directory, { fail: 'dependencies' })
  assert.equal(execute(directory).status, 1)
  assert.equal(state(directory).current, null)
  assert.equal(read(directory).calls.includes('start:nginx'), false)
  change(directory, { fail: null })
  const retry = execute(directory)
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(read(directory).calls.filter(call => call === 'start:release-migration').length, 1)
}))

for (const point of ['after-create:postgres', 'after-start:postgres', 'after-start:minio', 'after-start:minio-init', 'after-migration']) {
  test(`interrupted bootstrap at ${point} resumes without recreating or restarting observed resources`, () => fixture(directory => {
    change(directory, { kill: point })
    assert.notEqual(execute(directory).status, 0)
    const calls = read(directory).calls.filter(call => /^(create:|start:)/.test(call))
    change(directory, { kill: null })
    const retry = execute(directory)
    assert.equal(retry.status, 0, retry.stderr)
    // MinIO is deliberately stopped for the baseline backup then started by
    // continue; stopped application placeholders are replaced by candidates.
    for (const call of calls) {
      const expected = call === 'start:minio' || /^create:(php|report-worker|outbox-worker|report-scheduler|nginx)$/.test(call) ? 2 : 1
      assert.equal(read(directory).calls.filter(value => value === call).length, expected, call)
    }
  }))
}

for (const problem of ['existing_resource', 'database_objects', 'bucket_exit']) {
  test(`${problem} refuses adoption or initialization without publishing a state`, () => fixture(directory => {
    change(directory, { [problem]: 1 })
    assert.equal(execute(directory).status, 1)
    assert.equal(fs.existsSync(join(directory, 'state.json')), false)
    assert.equal(read(directory).calls.includes('migration'), false)
  }))
}

test('changed runtime/candidate and missing source containers fail closed on retry', () => fixture(directory => {
  change(directory, { fail: 'bucket' })
  assert.equal(execute(directory).status, 1)
  change(directory, { fail: null, configuration: true })
  assert.equal(execute(directory).status, 1)
  change(directory, { configuration: false })
  assert.equal(execute(directory, "manifest.pipeline_id='999';").status, 1)
  const data = read(directory);delete data.containers.php;change(directory, data)
  assert.equal(execute(directory).status, 1)
}))

for (const problem of ['mismatched-database', 'external-volume', 'existing-state']) {
  test(`${problem} is rejected before any resource creation`, () => fixture(directory => {
    const data = read(directory)
    if (problem === 'mismatched-database') data.compose.services.php.environment.DB_DATABASE = 'other'
    if (problem === 'external-volume') data.compose.volumes.data.external = true
    if (problem === 'existing-state') fs.writeFileSync(join(directory, 'state.json'), '{}')
    change(directory, data)
    assert.equal(execute(directory).status, 1)
    assert.equal(read(directory).calls.some(call => call.startsWith('create:')), false)
  }))
}

test('bootstrap shares the release.sh operation lock and performs no work if held', () => fixture(async directory => {
  const holder = spawn('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;echo locked;read done'], {
    env: { PATH: process.env.PATH, TEST_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve);holder.once('error', reject) })
    const shell = fileURLToPath(new URL('./release.sh', import.meta.url))
    const result = spawnSync('sh', [shell, 'bootstrap', directory, 'unused', 'unused', 'unused', 'pizza-backup-test', join(directory, 'backup')], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.deepEqual(read(directory).calls, [])
    assert.equal(fs.existsSync(join(directory, 'state.json')), false)
  } finally {
    const exited = new Promise(resolve => holder.once('exit', resolve));holder.stdin.end('done\n');await exited
  }
}))

test('release.sh bootstrap reaches the CLI without an import cycle and sanitizes invalid input', () => fixture(directory => {
  const manifestPath = join(directory, 'manifest.json')
  fs.writeFileSync(manifestPath, '{"secret-canary":')
  const result = spawnSync('sh', [fileURLToPath(new URL('./release.sh', import.meta.url)), 'bootstrap', directory,
    manifestPath, 'unused', 'unused', 'pizza-backup-test', join(directory, 'backup')], { encoding: 'utf8', timeout: 5000 })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Release bootstrap failed/)
  assert.equal((result.stdout + result.stderr).includes('secret-canary'), false)
  assert.equal(fs.existsSync(join(directory, 'state.json')), false)
}))
