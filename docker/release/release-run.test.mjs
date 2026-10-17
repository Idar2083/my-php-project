import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { create } from './manifest.mjs'
import { initialState } from './state.mjs'
import { writerOrder } from './coordinator-docker.mjs'
import { applicationServices, infrastructureServices, descriptor } from './release-runtime.mjs'
import { container } from './release-test-support.mjs'

const coordinator = new URL('./coordinator.mjs', import.meta.url).href
const continuation = new URL('./release-run.mjs', import.meta.url).href
const support = new URL('./release-test-support.mjs', import.meta.url).href
const manifest = create({ CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123', PHP_IMAGE: 'registry.example.test/pizza/php@sha256:' + 'b'.repeat(64), NGINX_IMAGE: 'registry.example.test/pizza/nginx@sha256:' + 'c'.repeat(64) })
const baseline = { ...initialState('pizza-backup-test'), revision: 10, current: { ...manifest, pipeline_id: '122' } }
function read(directory) { return JSON.parse(fs.readFileSync(join(directory, 'fixture.json'), 'utf8')) }
function change(directory, patch) { fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ ...read(directory), ...patch })) }
function state(directory) { return JSON.parse(fs.readFileSync(join(directory, 'state.json'), 'utf8')) }
function execute(directory, operation = 'continueRelease', code = '') {
  return spawnSync('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;exec node --input-type=module -e "$TEST_CODE"'], {
    encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, TEST_DIRECTORY: directory, TEST_CODE: `
      import fs from 'node:fs';
      import {backupRelease} from ${JSON.stringify(coordinator)};
      import {continueRelease} from ${JSON.stringify(continuation)};
      import {FakeReleaseDriver} from ${JSON.stringify(support)};
      const directory=process.env.TEST_DIRECTORY;
      const driver=new FakeReleaseDriver(directory+'/fixture.json');
      const manifest=${JSON.stringify(manifest)};
      ${code}
      try { await ${operation}(directory,manifest,'unused-bundle','unused-runtime',directory+'/backup',driver) }
      catch {process.stderr.write('Release failed safely.');process.exitCode=1}
    ` },
  })
}
async function fixture(run, password = 'public-fixture') {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-release-run-'))
  try {
    fs.mkdirSync(join(directory, 'backup'), { mode: 0o700 })
    fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(baseline), { mode: 0o600 })
    const env = { APP_ENV: 'production', APP_DEBUG: 'false', DB_CONNECTION: 'pgsql', DB_HOST: 'postgres', DB_PORT: '5432', DB_DATABASE: 'pizza', DB_USERNAME: 'pizza', DB_PASSWORD: password }
    const names = [...infrastructureServices, ...applicationServices, 'minio-init']
    const compose = { name: baseline.project, services: Object.fromEntries(names.map(name => [name, { image: name === 'nginx' ? manifest.images.nginx : manifest.images.php,
      environment: name === 'nginx' ? {} : env, healthcheck: { test: ['CMD', 'true'] }, networks: { default: null } }])), networks: { default: { name: 'pizza-backup-test_default' } } }
    fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ calls: [], stops: [], counter: 100, compose,
      containers: Object.fromEntries(names.map((name, index) => [name, container(name, compose.services[name], index + 1)])),
      writers: writerOrder.map((service, index) => ({ id: (index + 1).toString(16).padStart(64, '0'), service, image: 'sha256:' + 'e'.repeat(64), started_at: 'initial', running: true, exit_code: 0, oom: false })) }))
    const result = execute(directory, 'backupRelease')
    assert.equal(result.status, 0, result.stderr)
    change(directory, { calls: [] })
    await run(directory)
  } finally { fs.rmSync(directory, { recursive: true }) }
}
function folder(directory) { return join(directory, fs.readdirSync(directory).find(name => name.startsWith('launch-')) || 'absent-launch') }

test('confirmed backup -> migration -> gated services -> health -> atomic current/previous and release_succeeded', () => fixture(directory => {
  const result = execute(directory)
  assert.equal(result.status, 0, result.stderr)
  const stored = state(directory), data = read(directory)
  assert.equal(stored.operation, null)
  assert.deepEqual(stored.current, manifest)
  assert.deepEqual(stored.previous, baseline.current)
  const calls = data.calls
  assert.ok(calls.indexOf('after-migration') < calls.indexOf('start:minio'))
  assert.ok(calls.indexOf('schema-status') < calls.indexOf('dependencies'))
  assert.ok(calls.indexOf('dependencies') < calls.indexOf('start:report-worker'))
  assert.ok(calls.indexOf('after-start:report-scheduler') < calls.indexOf('start:nginx'))
  assert.ok(calls.indexOf('api') < calls.indexOf('cleanup'))
  assert.equal(JSON.parse(fs.readFileSync(join(folder(directory), 'release-succeeded.json'))).event, 'release_succeeded')
  assert.equal(fs.statSync(join(folder(directory), 'compose.json')).mode & 0o777, 0o600)
  assert.equal(fs.readFileSync(join(folder(directory), 'plan.json'), 'utf8').includes('public-fixture'), false)
  const bytes = fs.readFileSync(join(directory, 'state.json'), 'utf8')
  change(directory, { calls: [] })
  assert.equal(execute(directory).status, 0)
  assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), bytes)
  assert.equal(read(directory).calls.some(call => call.startsWith('start:') || call.startsWith('create:') || call === 'migration'), false)
}))

for (const failure of ['restore', 'create:release-migration', 'start:release-migration', 'migration', 'start:minio', 'create:php', 'start:php', 'schema-status', 'dependencies',
  'create:report-worker', 'start:report-worker', 'create:outbox-worker', 'start:outbox-worker', 'create:report-scheduler', 'start:report-scheduler', 'create:nginx', 'start:nginx', 'api']) {
  test(`${failure} never records success and can safely continue the same operation`, () => fixture(directory => {
    change(directory, { fail: failure })
    const result = execute(directory)
    assert.equal(result.status, 1, result.stderr)
    assert.notEqual(state(directory).operation, null)
    assert.deepEqual(state(directory).current, baseline.current)
    assert.equal(fs.existsSync(join(folder(directory), 'release-succeeded.json')), false)
    change(directory, { fail: null })
    const retry = execute(directory)
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(state(directory).operation, null)
    assert.equal(read(directory).calls.filter(call => call === 'start:release-migration').length, failure === 'start:release-migration' ? 2 : 1)
  }))
}

for (const point of ['after-create:release-migration', 'after-start:release-migration', 'after-migration', 'after-start:minio', 'after-create:php', 'after-start:php', 'after-start:report-worker', 'after-start:nginx', 'after-cleanup']) {
  test(`SIGKILL ${point} resumes observed containers without replaying a migration or start`, () => fixture(directory => {
    change(directory, { kill: point })
    assert.notEqual(execute(directory).status, 0)
    const started = read(directory).calls.filter(call => call.startsWith('start:'))
    change(directory, { kill: null })
    const retry = execute(directory)
    assert.equal(retry.status, 0, retry.stderr)
    const calls = read(directory).calls
    for (const call of started) assert.equal(calls.filter(item => item === call).length, 1)
    assert.equal(state(directory).operation, null)
  }))
}

for (const name of [...infrastructureServices, ...applicationServices]) {
  test(`unhealthy ${name} blocks success and downstream writers`, () => fixture(directory => {
    if (['postgres', 'redis', 'rabbitmq'].includes(name)) {
      const value = read(directory);value.containers[name].State.Health.Status = 'unhealthy';change(directory, value)
    } else change(directory, { unhealthy: name })
    assert.equal(execute(directory).status, 1)
    assert.notEqual(state(directory).operation, null)
    assert.deepEqual(state(directory).current, baseline.current)
    if (name !== 'nginx') assert.equal(read(directory).calls.includes('start:nginx'), false)
    if (['postgres', 'redis', 'rabbitmq', 'minio', 'php'].includes(name)) assert.equal(read(directory).calls.includes('start:report-worker'), false)
  }))
}

test('failed/partial migration is never rerun and no application starts', () => fixture(directory => {
  change(directory, { migration_exit: 75 })
  assert.equal(execute(directory).status, 1)
  assert.equal(state(directory).operation.phase, 'migrating')
  assert.equal(read(directory).calls.includes('start:minio'), false)
  change(directory, { migration_exit: 0 })
  // Docker wait must return the persisted failure, regardless of new settings.
  assert.equal(execute(directory).status, 1)
  assert.equal(read(directory).calls.filter(call => call === 'start:release-migration').length, 1)
}))

for (const problem of ['replacement', 'restart', 'oom', 'runtime', 'deleted-task', 'frozen-config']) {
  test(`${problem} after interruption fails closed`, () => fixture(directory => {
    change(directory, { fail: 'schema-status' })
    assert.equal(execute(directory).status, 1)
    const value = read(directory);value.fail = null
    if (problem === 'replacement') value.containers.php.Id = 'f'.repeat(64)
    if (problem === 'restart') value.containers.php.State.StartedAt = 'restarted'
    if (problem === 'oom') value.containers.php.State.OOMKilled = true
    if (problem === 'runtime') value.configuration = true
    if (problem === 'deleted-task') delete value.containers['release-migration']
    change(directory, value)
    if (problem === 'frozen-config') fs.appendFileSync(join(folder(directory), 'compose.json'), 'broken')
    const before = fs.readFileSync(join(directory, 'state.json'), 'utf8')
    assert.equal(execute(directory).status, 1)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), before)
    assert.equal(read(directory).calls.includes('start:report-worker'), false)
  }))
}

for (const phase of ['migrating', 'migrated', 'starting', 'verified', 'committed']) {
  test(`SIGKILL after state publication ${phase} resumes without changing previous prematurely`, () => fixture(directory => {
    const code = `const rename=fs.renameSync;fs.renameSync=(src,dst)=>{const value=JSON.parse(fs.readFileSync(src));const selected=dst===directory+'/state.json'&&${JSON.stringify(phase)}===(value.operation?.phase??'committed');const result=rename(src,dst);if(selected)process.kill(process.pid,'SIGKILL');return result};`
    assert.notEqual(execute(directory, 'continueRelease', code).status, 0)
    const retry = execute(directory)
    assert.equal(retry.status, 0, retry.stderr)
    assert.deepEqual(state(directory).previous, baseline.current)
    assert.equal(read(directory).calls.filter(call => call === 'start:release-migration').length, 1)
  }))
}

for (const phase of ['migrating', 'migrated', 'starting', 'verified', 'committed']) {
  test(`failed persistence of ${phase} never reports success and safely resumes`, () => fixture(directory => {
    const code = `const rename=fs.renameSync;fs.renameSync=(src,dst)=>{const value=JSON.parse(fs.readFileSync(src));if(dst===directory+'/state.json'&&${JSON.stringify(phase)}===(value.operation?.phase??'committed'))throw new Error('controlled');return rename(src,dst)};`
    assert.equal(execute(directory, 'continueRelease', code).status, 1)
    assert.deepEqual(state(directory).current, baseline.current)
    const retry = execute(directory)
    assert.equal(retry.status, 0, retry.stderr)
    assert.equal(read(directory).calls.filter(call => call === 'start:release-migration').length, 1)
  }))
}

test('cleanup failure is retryable after commit without repeating migration/start or claiming success', () => fixture(directory => {
  change(directory, { fail: 'cleanup' })
  assert.equal(execute(directory).status, 1)
  assert.equal(state(directory).operation, null)
  assert.equal(fs.existsSync(join(folder(directory), 'release-succeeded.json')), false)
  change(directory, { fail: null, calls: [] })
  assert.equal(execute(directory).status, 0)
  assert.equal(read(directory).calls.some(call => call.startsWith('start:') || call === 'migration'), false)
}))

test('backup corruption and a different candidate are refused before migration or starts', () => fixture(directory => {
  const copy = fs.readdirSync(join(directory, 'backup')).find(name => /^[a-f0-9]{64}$/.test(name))
  fs.appendFileSync(join(directory, 'backup', copy, 'minio.zip'), 'corrupted')
  const before = fs.readFileSync(join(directory, 'state.json'), 'utf8')
  assert.equal(execute(directory).status, 1)
  assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), before)
  assert.equal(read(directory).calls.some(call => call.startsWith('start:') || call === 'migration'), false)
  assert.equal(execute(directory, 'continueRelease', "manifest.pipeline_id='999';").status, 1)
}))

test('a new run cannot skip backup_ready or invent a missing launch journal', () => fixture(directory => {
  for (const phase of ['prepared', 'images_ready', 'quiescing', 'quiesced', 'migrating', 'migrated', 'starting', 'verified']) {
    const value = state(directory);value.operation.phase = phase;fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(value))
    change(directory, { calls: [] })
    assert.equal(execute(directory).status, 1)
    assert.equal(read(directory).calls.some(call => call.startsWith('start:') || call === 'migration'), false)
  }
}))

test('inspection treats an unspecified OOM-disable flag as false, while detecting true and other settings', () => {
  const item = container('php'), original = descriptor(item)
  item.HostConfig.OomKillDisable = false
  assert.deepEqual(descriptor(item), original)
  item.HostConfig.OomKillDisable = true
  assert.notDeepEqual(descriptor(item), original)
  item.HostConfig.OomKillDisable = false;item.HostConfig.Privileged = true
  assert.notDeepEqual(descriptor(item), original)
})

test('literal dollar credentials match the source DB and frozen candidate environment', () => fixture(directory => {
  const result = execute(directory)
  assert.equal(result.status, 0, result.stderr)
  assert.ok(read(directory).containers.php.Config.Env.includes('DB_PASSWORD=dollar$value'))
}, 'dollar$$value'))

test('concurrent continue command is rejected by the common lock before any action', () => fixture(async directory => {
  const holder = spawn('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;echo locked;read done'], {
    env: { PATH: process.env.PATH, TEST_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve);holder.once('error', reject);holder.once('exit', () => reject(new Error('Lock holder exited'))) })
    const before = fs.readFileSync(join(directory, 'state.json'), 'utf8')
    const shell = fileURLToPath(new URL('./release.sh', import.meta.url))
    const result = spawnSync('sh', [shell, 'continue', directory, 'unused', 'unused', 'unused', 'unused', join(directory, 'backup')], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), before)
    assert.deepEqual(read(directory).calls, [])
  } finally {
    const exited = new Promise(resolve => holder.once('exit', resolve));holder.stdin.end('done\n');await exited
  }
}))

test('health timeout leaves migrating and never launches a migration or any application writer', () => fixture(directory => {
  const value = read(directory);value.containers.postgres.State.Health.Status = 'starting';change(directory, value)
  const code = 'const now=Date.now();let tick=0;Date.now=()=>now+200000*tick++;'
  assert.equal(execute(directory, 'continueRelease', code).status, 1)
  assert.equal(state(directory).operation.phase, 'migrating')
  assert.equal(read(directory).calls.some(call => call.startsWith('start:')), false)
}))

test('failure to publish success receipt after commit can finish without replaying work', () => fixture(directory => {
  const code = `const link=fs.linkSync;fs.linkSync=(src,dst)=>{if(dst.endsWith('/release-succeeded.json'))throw new Error('controlled');return link(src,dst)};`
  assert.equal(execute(directory, 'continueRelease', code).status, 1)
  assert.equal(state(directory).operation, null)
  assert.equal(fs.existsSync(join(folder(directory), 'release-succeeded.json')), false)
  change(directory, { calls: [] })
  assert.equal(execute(directory).status, 0)
  assert.equal(read(directory).calls.some(call => call.startsWith('start:') || call === 'migration'), false)
}))

for (const role of ['php', 'release-migration']) {
  test(`a changed ${role} StartedAt during initialization cannot be accepted as healthy`, () => fixture(directory => {
    const code = `const inspect=driver.backup.inspect;let changed=false;driver.backup.inspect=id=>{
      const item=inspect(id);
      if(!changed&&item.Config.Labels['com.docker.compose.service']===${JSON.stringify(role)}&&item.State.Running){
        changed=true;const value=driver.read();value.containers[${JSON.stringify(role)}].State.StartedAt='restarted-before-health';driver.write(value);
      }
      return item;
    };`
    assert.equal(execute(directory, 'continueRelease', code).status, 1)
    assert.notEqual(state(directory).operation, null)
    assert.deepEqual(state(directory).current, baseline.current)
    assert.equal(fs.existsSync(join(folder(directory), 'release-succeeded.json')), false)
  }))
}

test('a source PHP database different from the backed-up PostgreSQL is rejected before migration', () => fixture(directory => {
  const value = read(directory)
  value.containers.php.Config.Env = value.containers.php.Config.Env.map(item => item.startsWith('DB_DATABASE=') ? 'DB_DATABASE=other-database' : item)
  change(directory, value)
  assert.equal(execute(directory).status, 1)
  assert.equal(state(directory).operation.phase, 'backup_ready')
  assert.equal(read(directory).calls.some(call => call.startsWith('start:') || call === 'migration'), false)
}))

test('release.sh continue executes the CLI to release_succeeded with fake Docker, without module-cycle deadlock', () => fixture(directory => {
  change(directory, { fail: 'create:release-migration' })
  assert.equal(execute(directory).status, 1)
  change(directory, { fail: null })
  fs.writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
  const sources = read(directory).containers
  fs.writeFileSync(join(directory, 'settings.json'), JSON.stringify({ schema_version: 1, project: baseline.project,
    postgres_container: sources.postgres.Id, minio_container: sources.minio.Id, utility_image: 'sha256:' + 'e'.repeat(64), reserve_bytes: 67108864 }))
  const bin = join(directory, 'bin');fs.mkdirSync(bin)
  const shim = join(bin, 'docker.mjs')
  fs.writeFileSync(shim, `
    import {FakeReleaseDriver} from ${JSON.stringify(support)};
    const driver=new FakeReleaseDriver(${JSON.stringify(join(directory, 'fixture.json'))});
    const args=process.argv.slice(2);
    try {
      let output;
      if(args[0]==='version')output=JSON.stringify({Os:'linux',Arch:'amd64'});
      else if(args[0]==='image')output=JSON.stringify([{Id:driver.image(args.at(-1)),RepoDigests:[args.at(-1)],Os:'linux',Architecture:'amd64'}]);
      else if(args[0]==='inspect')output=JSON.stringify([driver.backup.inspect(args[1])]);
      else if(args[0]==='compose'&&args.includes('config'))output=JSON.stringify(driver.check());
      else if(args[0]==='run'&&args.includes('pg_restore')){driver.hit('toc');output='';}
      else output=driver.run(args);
      process.stdout.write(output??'');
    }catch{process.exitCode=1;}
  `)
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  fs.writeFileSync(join(bin, 'docker'), `#!/bin/sh\nexec ${quote(process.execPath)} -- ${quote(shim)} "$@"\n`, { mode: 0o700 })
  const script = fileURLToPath(new URL('./release.sh', import.meta.url))
  const args = [script, 'continue', directory, join(directory, 'manifest.json'), 'unused-bundle', 'unused-runtime', join(directory, 'settings.json'), join(directory, 'backup')]
  const result = spawnSync('sh', args, { encoding: 'utf8', timeout: 90000, env: { PATH: `${bin}:${process.env.PATH}`, HOME: directory } })
  assert.equal(result.status, 0, JSON.stringify({ error: result.error?.message, stderr: result.stderr, phase: state(directory).operation?.phase, lastCalls: read(directory).calls.slice(-8) }))
  assert.equal(JSON.parse(result.stdout).event, 'release_succeeded')
  assert.equal(state(directory).operation, null)
  assert.equal(result.stdout.includes('public-fixture'), false)
}))
