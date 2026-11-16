import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { create } from './manifest.mjs'
import { initialState, identity } from './state.mjs'
import { writerOrder } from './coordinator-docker.mjs'
import { applicationServices, infrastructureServices, descriptor } from './release-runtime.mjs'
import { container } from './release-test-support.mjs'

const coordinator = new URL('./coordinator.mjs', import.meta.url).href
const continuation = new URL('./release-run.mjs', import.meta.url).href
const recovery = new URL('./recovery.mjs', import.meta.url).href
const restoration = new URL('./restore-release.mjs', import.meta.url).href
const restoreSupport = new URL('./restore-test-support.mjs', import.meta.url).href
const support = new URL('./release-test-support.mjs', import.meta.url).href
const manifest = create({ CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123', PHP_IMAGE: 'registry.example.test/pizza/php@sha256:' + 'b'.repeat(64), NGINX_IMAGE: 'registry.example.test/pizza/nginx@sha256:' + 'c'.repeat(64) })
const baseline = { ...initialState('pizza-backup-test'), revision: 10, current: { ...manifest, pipeline_id: '122' } }
function read(directory) { return JSON.parse(fs.readFileSync(join(directory, 'fixture.json'), 'utf8')) }
function change(directory, patch) { fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ ...read(directory), ...patch })) }
function state(directory) { return JSON.parse(fs.readFileSync(join(directory, 'state.json'), 'utf8')) }
function execute(directory, operation = 'recoverRelease', code = '') {
  return spawnSync('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;exec node --input-type=module -e "$TEST_CODE"'], {
    encoding: 'utf8', timeout: 20000, env: { PATH: process.env.PATH, TEST_DIRECTORY: directory, TEST_CODE: `
      import fs from 'node:fs';
      import {fixtureFailure} from ${JSON.stringify(new URL('./release-test-diagnostics.mjs', import.meta.url).href)};
      import {backupRelease} from ${JSON.stringify(coordinator)};
      import {continueRelease} from ${JSON.stringify(continuation)};
      import {recoverRelease} from ${JSON.stringify(recovery)};
      import {restoreRelease} from ${JSON.stringify(restoration)};
      import {FakeRestoreData} from ${JSON.stringify(restoreSupport)};
      import {FakeReleaseDriver} from ${JSON.stringify(support)};
      const directory=process.env.TEST_DIRECTORY;
      const driver=new FakeReleaseDriver(directory+'/fixture.json');
      const manifest=${JSON.stringify(manifest)};
      ${code}
      try { await ${operation}(directory,manifest,'unused-bundle','unused-runtime',directory+'/backup',${operation === 'restoreRelease' ? "'source-bundle','source-runtime'," : ''}driver${operation === 'restoreRelease' ? ',attempt' : ''}) }
      catch(error) {process.stderr.write(fixtureFailure(error, '${operation}'));process.exitCode=1}
    ` },
  })
}
async function fixture(run, password = 'public-fixture', current = baseline.current) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-release-run-'))
  try {
    fs.mkdirSync(join(directory, 'backup'), { mode: 0o700 })
    fs.writeFileSync(join(directory, 'state.json'), JSON.stringify({ ...baseline, current }), { mode: 0o600 })
    const env = { APP_ENV: 'production', APP_DEBUG: 'false', DB_CONNECTION: 'pgsql', DB_HOST: 'postgres', DB_PORT: '5432', DB_DATABASE: 'pizza', DB_USERNAME: 'pizza', DB_PASSWORD: password }
    const names = [...infrastructureServices, ...applicationServices, 'minio-init']
    const compose = { name: baseline.project, services: Object.fromEntries(names.map(name => [name, { image: name === 'nginx' ? manifest.images.nginx : manifest.images.php,
      environment: name === 'nginx' ? {} : env, healthcheck: { test: ['CMD', 'true'] }, networks: { default: null } }])), networks: { default: { name: 'pizza-backup-test_default' } } }
    compose.services.postgres.environment = { ...env, POSTGRES_DB: 'pizza', POSTGRES_USER: 'pizza', POSTGRES_PASSWORD: password }
    compose.services.postgres.volumes = [{ type: 'volume', source: 'pg', target: '/var/lib/postgresql/data' }]
    compose.services.minio.volumes = [{ type: 'volume', source: 'files', target: '/data' }]
    compose.volumes = { pg: { name: 'pizza-backup-test_pg' }, files: { name: 'pizza-backup-test_files' } }
    fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ calls: [], stops: [], counter: 100, compose,
      containers: Object.fromEntries(names.map((name, index) => [name, { ...container(name, compose.services[name], index + 1), Image: applicationServices.includes(name) ? 'sha256:' + current.images[name === 'nginx' ? 'nginx' : 'php'].split('@sha256:')[1] : 'sha256:' + 'e'.repeat(64) }])),
      writers: writerOrder.map((service, index) => ({ id: (names.indexOf(service) + 1).toString(16).padStart(64, '0'), service, image: applicationServices.includes(service) ? 'sha256:' + current.images[service === 'nginx' ? 'nginx' : 'php'].split('@sha256:')[1] : 'sha256:' + 'e'.repeat(64), started_at: 'initial', running: true, exit_code: 0, oom: false })) }))
    const result = execute(directory, 'backupRelease')
    assert.equal(result.status, 0, result.stderr)
    change(directory, { calls: [] })
    await run(directory)
  } finally { fs.rmSync(directory, { recursive: true }) }
}
function folder(directory) { return join(directory, fs.readdirSync(directory).find(name => name.startsWith('launch-')) || 'absent-launch') }

function recoveryFolder(directory) { return join(directory, fs.readdirSync(directory).find(name => name.startsWith('recovery-'))) }

test('rollback before migrations verifies backup and retained pinned images, gates writers, and preserves current/previous', () => fixture(directory => {
  assert.equal(execute(directory).status, 0)
  assert.equal(state(directory).operation, null)
  assert.deepEqual(state(directory).current, baseline.current)
  assert.deepEqual(state(directory).previous, baseline.previous)
  const data = read(directory), calls = data.calls
  assert.ok(calls.indexOf('restore') < calls.indexOf('start:minio'))
  assert.ok(calls.indexOf('dependencies') < calls.indexOf('start:report-worker'))
  assert.ok(calls.indexOf('after-start:report-scheduler') < calls.indexOf('start:nginx'))
  assert.equal(calls.some(call => call === 'migration' || call.startsWith('create:') || call.startsWith('pull:')), false)
  const receipt = JSON.parse(fs.readFileSync(join(recoveryFolder(directory), 'rollback-succeeded.json')))
  assert.equal(receipt.event, 'rollback_succeeded')
  assert.equal(fs.readFileSync(join(recoveryFolder(directory), 'plan.json'), 'utf8').includes('public-fixture'), false)
  change(directory, { calls: [] })
  assert.equal(execute(directory).status, 0)
  assert.equal(read(directory).calls.some(call => call.startsWith('start:')), false)
}))

for (const failure of ['restore', 'image:php', 'image:nginx', 'start:minio', 'start:php', 'dependencies', 'start:report-worker', 'start:outbox-worker', 'start:report-scheduler', 'start:nginx', 'api']) {
  test(`rollback ${failure} fails closed and resumes without repeating starts`, () => fixture(directory => {
    change(directory, { fail: failure })
    assert.equal(execute(directory).status, 1)
    assert.notEqual(state(directory).operation, null)
    assert.equal(fs.existsSync(join(recoveryFolder(directory), 'rollback-succeeded.json')), false)
    assert.equal(execute(directory, 'continueRelease').status, 1)
    change(directory, { fail: null })
    assert.equal(execute(directory).status, 0)
    assert.equal(state(directory).operation, null)
  }))
}

for (const service of ['minio', 'php', 'report-worker', 'outbox-worker', 'report-scheduler', 'nginx']) {
  test(`SIGKILL after rollback start ${service} adopts the observed container without replay`, () => fixture(directory => {
    change(directory, { kill: 'after-start:' + service })
    assert.equal(execute(directory).signal, 'SIGKILL')
    assert.equal(execute(directory, 'continueRelease').status, 1)
    change(directory, { kill: null })
    assert.equal(execute(directory).status, 0)
    assert.equal(read(directory).calls.filter(call => call === 'start:' + service).length, 1)
  }))
}

for (const phase of ['rolling_back', 'rollback_complete']) {
  test(`SIGKILL after publication ${phase} resumes without changing release pointers`, () => fixture(directory => {
    const code = `const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(b.endsWith('/state.json')){const s=JSON.parse(fs.readFileSync(b));if(${phase === 'rollback_complete' ? '!s.operation' : "s.operation?.phase==='rolling_back'"})process.kill(process.pid,'SIGKILL')}};`
    assert.equal(execute(directory, 'recoverRelease', code).signal, 'SIGKILL')
    assert.equal(execute(directory).status, 0)
    assert.deepEqual(state(directory).current, baseline.current)
  }))
}

for (const failure of ['create:release-migration', 'migration', 'start:php', 'start:outbox-worker', 'api']) {
  test(`after ${failure}, schema may have changed: manual recovery stops writers and never restores data or starts old code`, () => fixture(directory => {
    change(directory, { fail: failure })
    assert.equal(execute(directory, 'continueRelease').status, 1)
    change(directory, { fail: null, calls: [] })
    const result = execute(directory)
    assert.equal(result.status, 1)
    assert.equal(state(directory).operation.phase, 'recovery_required')
    assert.deepEqual(state(directory).current, baseline.current)
    const data = read(directory)
    assert.equal(data.calls.some(call => call.startsWith('start:') || call === 'migration' || call.startsWith('create:')), false)
    assert.ok(writerOrder.every(name => !data.containers[name].State.Running))
    assert.equal(fs.existsSync(join(recoveryFolder(directory), 'rollback-succeeded.json')), false)
    assert.equal(JSON.parse(fs.readFileSync(join(recoveryFolder(directory), 'recovery-required.json'))).reason, 'schema_may_have_changed')
    assert.equal(execute(directory, 'continueRelease').status, 1)
    assert.equal(execute(directory, 'backupRelease').status, 1)
    assert.equal(execute(directory).status, 1)
    assert.equal(state(directory).operation.phase, 'recovery_required')
  }))
}

test('failed migration exit is preserved for manual recovery, without retrying or reversing it', () => fixture(directory => {
  change(directory, { migration_exit: 1 })
  assert.equal(execute(directory, 'continueRelease').status, 1)
  change(directory, { calls: [] })
  assert.equal(execute(directory).status, 1)
  assert.equal(state(directory).operation.phase, 'recovery_required')
  assert.equal(read(directory).containers['release-migration'].State.ExitCode, 1)
  assert.equal(read(directory).calls.includes('migration'), false)
}))

for (const changeCode of [
  `fs.appendFileSync(directory+'/backup/'+fs.readdirSync(directory+'/backup').find(x=>!x.startsWith('.'))+'/postgres.dump','broken');`,
  `const v=driver.read();v.containers.php.Image='sha256:'+'f'.repeat(64);driver.write(v);`,
  `const v=driver.read();v.configuration=true;driver.write(v);`,
  `const v=driver.read();v.containers.php.State.OOMKilled=true;driver.write(v);`,
  `const v=driver.read();v.containers.php.State.StartedAt='foreign';driver.write(v);`,
]) {
  test('unsafe backup/config/source is rejected before starting any writer: ' + changeCode.slice(0, 55), () => fixture(directory => {
    assert.equal(execute(directory, 'recoverRelease', changeCode).status, 1)
    assert.equal(read(directory).calls.some(call => call.startsWith('start:')), false)
    assert.equal(state(directory).operation.phase, 'backup_ready')
  }))
}

test('SIGKILL during manual quiesce resumes stopping and never reports rollback success', () => fixture(directory => {
  change(directory, { fail: 'api' });assert.equal(execute(directory, 'continueRelease').status, 1)
  change(directory, { fail: null, kill: 'after-stop:nginx', calls: [] })
  assert.equal(execute(directory).signal, 'SIGKILL')
  assert.equal(state(directory).operation.phase, 'recovery_required')
  change(directory, { kill: null })
  assert.equal(execute(directory).status, 1)
  assert.ok(writerOrder.every(name => !read(directory).containers[name].State.Running))
  assert.equal(read(directory).calls.some(call => call.startsWith('start:')), false)
}))

for (const service of [...infrastructureServices, ...applicationServices]) {
  test(`unhealthy ${service} cannot publish rollback success`, () => fixture(directory => {
    const value = read(directory)
    value.unhealthy = service
    if (['postgres', 'redis', 'rabbitmq'].includes(service)) value.containers[service].State.Health.Status = 'unhealthy'
    change(directory, value)
    assert.equal(execute(directory).status, 1)
    assert.notEqual(state(directory).operation, null)
    assert.equal(fs.existsSync(join(recoveryFolder(directory), 'rollback-succeeded.json')), false)
  }))
}

for (const phase of ['rolling_back', 'rollback_complete']) {
  test(`persistence failure at ${phase} is recoverable without premature success`, () => fixture(directory => {
    const code = `const rename=fs.renameSync;fs.renameSync=(a,b)=>{if(b.endsWith('/state.json')){const s=JSON.parse(fs.readFileSync(a));if(${phase === 'rollback_complete' ? '!s.operation' : "s.operation?.phase==='rolling_back'"})throw new Error('controlled')}return rename(a,b)};`
    assert.equal(execute(directory, 'recoverRelease', code).status, 1)
    assert.equal(fs.existsSync(join(recoveryFolder(directory), 'rollback-succeeded.json')), false)
    if (phase === 'rolling_back') assert.equal(read(directory).calls.some(call => call.startsWith('start:')), false)
    assert.equal(execute(directory).status, 0)
  }))
}

test('SIGKILL after recovery plan publication prevents continue before phase persistence', () => fixture(directory => {
  const code = `const link=fs.linkSync;fs.linkSync=(a,b)=>{link(a,b);if(b.includes('/recovery-')&&b.endsWith('/plan.json'))process.kill(process.pid,'SIGKILL')};`
  assert.equal(execute(directory, 'recoverRelease', code).signal, 'SIGKILL')
  assert.equal(state(directory).operation.phase, 'backup_ready')
  assert.equal(execute(directory, 'continueRelease').status, 1)
  assert.equal(execute(directory).status, 0)
}))

test('damaged backup during rollback blocks subsequent writers', () => fixture(directory => {
  const code = `const run=driver.backup.run;driver.backup.run=args=>{const result=run(args);if(args[0]==='start'){const root=directory+'/backup';const path=root+'/'+fs.readdirSync(root).find(x=>!x.startsWith('.'));fs.appendFileSync(path+'/minio.zip','broken')}return result};`
  assert.equal(execute(directory, 'recoverRelease', code).status, 1)
  assert.equal(read(directory).calls.includes('start:php'), false)
  assert.equal(state(directory).operation.phase, 'rolling_back')
}))

test('an exited container after an unrecorded start is never restarted blindly', () => fixture(directory => {
  change(directory, { kill: 'after-start:php' });assert.equal(execute(directory).signal, 'SIGKILL')
  const value = read(directory);value.kill = null
  Object.assign(value.containers.php.State, { Running: false, Status: 'exited' });change(directory, value)
  assert.equal(execute(directory).status, 1)
  assert.equal(read(directory).calls.filter(call => call === 'start:php').length, 1)
}))

test('migration still running after SIGKILL requires manual recovery and is never relaunched', () => fixture(directory => {
  change(directory, { kill: 'after-start:release-migration' })
  assert.equal(execute(directory, 'continueRelease').signal, 'SIGKILL')
  change(directory, { kill: null, calls: [] })
  assert.equal(execute(directory).status, 1)
  assert.equal(state(directory).operation.phase, 'recovery_required')
  assert.equal(read(directory).containers['release-migration'].State.Running, true)
  assert.equal(read(directory).calls.some(call => call.startsWith('start:') || call === 'migration'), false)
}))

for (const service of ['nginx', 'php', 'minio']) {
  test(`manual recovery stop failure at ${service} remains diagnostic and retries only stopping`, () => fixture(directory => {
    change(directory, { fail: 'api' });assert.equal(execute(directory, 'continueRelease').status, 1)
    change(directory, { fail: 'stop:' + service, calls: [] })
    assert.equal(execute(directory).status, 1)
    assert.equal(state(directory).operation.phase, 'recovery_required')
    change(directory, { fail: null })
    assert.equal(execute(directory).status, 1)
    assert.ok(writerOrder.every(name => !read(directory).containers[name].State.Running))
    assert.equal(read(directory).calls.some(call => call.startsWith('start:')), false)
  }))
}

test('committed releases, first installs and pre-backup states are ineligible without publishing an intent', () => fixture(directory => {
  const before = state(directory)
  for (const invalid of [
    { ...before, operation: null },
    { ...before, current: null },
    { ...before, operation: { ...before.operation, phase: 'quiesced' } },
  ]) {
    fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(invalid))
    assert.equal(execute(directory).status, 1)
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('recovery-')), false)
  }
}))

test('the common CLI lock rejects parallel rollback before inspecting any supplied files', () => fixture(async directory => {
  const holder = spawn('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;echo locked;read done'], { env: { PATH: process.env.PATH, TEST_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve);holder.once('error', reject) })
    const result = spawnSync('sh', [fileURLToPath(new URL('./release.sh', import.meta.url)), 'rollback', directory, 'unused', 'unused', 'unused', 'unused', join(directory, 'backup')], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.deepEqual(read(directory).calls, [])
  } finally {
    const exited = new Promise(resolve => holder.once('exit', resolve));holder.stdin.end('done\n');await exited
  }
}))

test('success receipt failure after rollback completion retries without replaying starts', () => fixture(directory => {
  const code = `const link=fs.linkSync;fs.linkSync=(a,b)=>{if(b.endsWith('/rollback-succeeded.json'))throw new Error('controlled');return link(a,b)};`
  assert.equal(execute(directory, 'recoverRelease', code).status, 1)
  assert.equal(state(directory).operation, null)
  change(directory, { calls: [] })
  assert.equal(execute(directory).status, 0)
  assert.equal(read(directory).calls.some(call => call.startsWith('start:')), false)
}))

test('state persistence cannot enter recovery without the original verified backup evidence', () => fixture(directory => {
  const stateModule = new URL('./state.mjs', import.meta.url).href
  const code = `const {persist,recoveryTransition}=await import(${JSON.stringify(stateModule)});const s=JSON.parse(fs.readFileSync(directory+'/state.json'));persist(directory,s,recoveryTransition(s,'rolling_back'));`
  assert.equal(execute(directory, 'recoverRelease', code).status, 1)
  assert.equal(state(directory).operation.phase, 'backup_ready')
  assert.equal(read(directory).calls.some(call => call.startsWith('start:')), false)
}))

test('release.sh rollback dispatch holds the lock and completes with native DockerCoordinator and fake Docker', () => fixture(directory => {
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
  // Complete the private plan with fake restore support first. Native TOC checks
  // and all subsequent lifecycle operations still go through the CLI shim.
  change(directory, { fail: 'start:minio' });assert.equal(execute(directory).status, 1);change(directory, { fail: null })
  const args = [fileURLToPath(new URL('./release.sh', import.meta.url)), 'rollback', directory,
    join(directory, 'manifest.json'), 'unused-bundle', 'unused-runtime', join(directory, 'settings.json'), join(directory, 'backup')]
  // Only the isolated restore test is stubbed: real archive restore is covered
  // by backup-docker.test; fake archives cannot be fed to a real pg_restore.
  const module = new URL('./recovery.mjs', import.meta.url).href
  const entry = join(bin, 'entry.mjs')
  fs.writeFileSync(entry, `import {recoverRelease} from ${JSON.stringify(module)};import {DockerCoordinator} from ${JSON.stringify(new URL('./coordinator-docker.mjs', import.meta.url).href)};import fs from 'node:fs';
    const d=new DockerCoordinator(JSON.parse(fs.readFileSync(process.argv[7])));d.backup.restore=()=>{};
    try{const s=recoverRelease(process.argv[3],JSON.parse(fs.readFileSync(process.argv[4])),process.argv[5],process.argv[6],process.argv[8],d);console.log(JSON.stringify({event:'rollback_succeeded',revision:s.revision}))}catch{process.exitCode=1}`)
  // Route node recovery.mjs through the fixture entry while keeping release.sh,
  // the operation lock, native DockerCoordinator and process boundary intact.
  fs.writeFileSync(join(bin, 'node'), `#!/bin/sh\ncase "$1" in */recovery.mjs) shift ;; *) exit 1 ;; esac\nexec ${quote(process.execPath)} -- ${quote(entry)} "$@"\n`, { mode: 0o700 })
  const result = spawnSync('sh', args, { encoding: 'utf8', timeout: 90000, env: { PATH: `${bin}:${process.env.PATH}`, HOME: directory } })
  assert.equal(result.status, 0, JSON.stringify({error:result.error?.message,stderr:result.stderr,phase:state(directory).operation?.phase}))
  assert.equal(JSON.parse(result.stdout).event, 'rollback_succeeded')
  assert.equal(state(directory).operation, null)
  assert.equal(result.stdout.includes('public-fixture'), false)
}))

test('recovery phases cannot re-enter the ordinary forward state machine', () => fixture(directory => {
  const stateModule = new URL('./state.mjs', import.meta.url).href
  const code = `const {advance,recoveryTransition}=await import(${JSON.stringify(stateModule)});const s=JSON.parse(fs.readFileSync(directory+'/state.json'));const pending=recoveryTransition(s,'rolling_back');advance(pending,manifest,'prepared');`
  assert.equal(execute(directory, 'recoverRelease', code).status, 1)
  assert.equal(state(directory).operation.phase, 'backup_ready')
}))

for (const mutation of [
  `value.configuration=true;`,
  `value.containers.php.HostConfig.Privileged=true;`,
  `value.containers.php.NetworkSettings.Networks['pizza-backup-test_default'].NetworkID='foreign';`,
]) {
  test('configuration/container/network change during rollback blocks subsequent writers: ' + mutation, () => fixture(directory => {
    const code = `const run=driver.backup.run;driver.backup.run=args=>{const result=run(args);if(args[0]==='start'){const value=driver.read();${mutation}driver.write(value)}return result};`
    assert.equal(execute(directory, 'recoverRelease', code).status, 1)
    assert.equal(read(directory).calls.includes('start:report-worker'), false)
    assert.notEqual(state(directory).operation, null)
    assert.equal(fs.existsSync(join(recoveryFolder(directory), 'rollback-succeeded.json')), false)
  }))
}

test('a dangling recovery intent blocks continue before migration or any writer start', () => fixture(directory => {
  fs.symlinkSync(join(directory, 'missing-intent'), join(directory, 'recovery-' + identity(manifest)))
  assert.equal(execute(directory, 'continueRelease').status, 1)
  assert.equal(read(directory).calls.some(call => call.startsWith('start:') || call === 'migration'), false)
  assert.equal(state(directory).operation.phase, 'backup_ready')
}))


test('a dangling operation receipt is rejected rather than treated as absent', () => fixture(async directory => {
  const { ReleaseRuntime } = await import('./release-runtime.mjs')
  fs.symlinkSync(join(directory, 'missing-receipt'), join(directory, 'started-php.json'))
  const runtime = new ReleaseRuntime({}, directory, {})
  assert.throws(() => runtime.read('started-php'))
}))

const restoreCode = "const attempt=1;const settings=directory+'/restore-original-settings.json';if(!fs.existsSync(settings))fs.writeFileSync(settings,JSON.stringify(driver.backup.config));driver.backup.config=JSON.parse(fs.readFileSync(settings));driver.restoreData=(path,plan)=>new FakeRestoreData(driver,path,plan);"
function failedUpgrade(directory, failure = 'api') {
  change(directory, { fail: failure, restoreMode: true })
  assert.equal(execute(directory, 'continueRelease').status, 1)
  change(directory, { fail: null, calls: [] })
}

test('data recovery restores backup before old images start, publishes volume mapping only after readiness, and is idempotent', () => fixture(directory => {
  failedUpgrade(directory)
  const result = execute(directory, 'restoreRelease', restoreCode)
  assert.equal(result.status, 0, JSON.stringify({ error: result.error?.code, stderr: result.stderr, calls: read(directory).calls.slice(-12), phase: state(directory).operation?.phase }))
  const stored = state(directory), calls = read(directory).calls
  assert.deepEqual(stored.current, baseline.current)
  assert.deepEqual(stored.previous, baseline.previous)
  assert.equal(stored.operation, null)
  assert.match(stored.data.postgres, /^pizza-recovered-/)
  assert.ok(calls.indexOf('restore-database') < calls.indexOf('create:postgres'))
  assert.ok(calls.indexOf('restore-files') < calls.indexOf('start:php'))
  assert.ok(calls.indexOf('dependencies') < calls.indexOf('start:nginx'))
  const root = join(recoveryFolder(directory), 'restore')
  assert.equal(JSON.parse(fs.readFileSync(join(root, 'backup-settings.json'))).postgres_container, read(directory).containers.postgres.Id)
  assert.equal(fs.readFileSync(join(root, 'plan.json'), 'utf8').includes('public-fixture'), false)
  const bytes = fs.readFileSync(join(directory, 'state.json'), 'utf8')
  change(directory, { calls: [] })
  const retry = execute(directory, 'restoreRelease', restoreCode)
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), bytes)
  assert.equal(read(directory).calls.some(call => /^(restore-database|restore-files|create:|start:)/.test(call)), false)
}))

test('terminal restore failure keeps the backup and state, blocks replay, and permits an explicit fresh attempt', () => fixture(directory => {
  failedUpgrade(directory)
  change(directory, { data_exit: 1 })
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  assert.equal(state(directory).operation.phase, 'recovery_required')
  assert.equal(state(directory).data, undefined)
  assert.equal(read(directory).calls.includes('create:postgres'), false)
  change(directory, { data_exit: 0, calls: [] })
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  assert.equal(read(directory).calls.includes('restore-database'), false)
  const retry = execute(directory, 'restoreRelease', restoreCode.replace('attempt=1', 'attempt=2'))
  assert.equal(retry.status, 0, retry.stderr)
  assert.equal(state(directory).operation, null)
  assert.ok(fs.existsSync(join(recoveryFolder(directory), 'restore', 'data-1', 'failed.json')))
}))

test('interruption after a failed restore can finish abandon without replay, then use fresh staging', () => fixture(directory => {
  failedUpgrade(directory)
  change(directory, { data_exit: 1 })
  const code = restoreCode + "const link=fs.linkSync;fs.linkSync=(a,b)=>{link(a,b);if(b.endsWith('/failed.json'))process.kill(process.pid,'SIGKILL')};"
  assert.equal(execute(directory, 'restoreRelease', code).signal, 'SIGKILL')
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  assert.ok(fs.existsSync(join(recoveryFolder(directory), 'restore', 'data-1', 'abandoned.json')))
  change(directory, { data_exit: 0 })
  const result = execute(directory, 'restoreRelease', restoreCode.replace('attempt=1', 'attempt=2'))
  assert.equal(result.status, 0, result.stderr)
}))

test('restored dependency readiness failure leaves recovery pending; repeat never imports again', () => fixture(directory => {
  failedUpgrade(directory, 'start:php')
  change(directory, { fail: 'dependencies' })
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  assert.equal(state(directory).operation.phase, 'recovery_required')
  assert.equal(state(directory).data, undefined)
  assert.equal(read(directory).calls.includes('start:nginx'), false)
  change(directory, { fail: null, calls: [] })
  const result = execute(directory, 'restoreRelease', restoreCode)
  assert.equal(result.status, 0, result.stderr)
  assert.equal(read(directory).calls.some(call => call === 'restore-database' || call === 'restore-files'), false)
}))

for (const point of ['after-stop:postgres', 'after-restore-database', 'after-restore-files', 'after-create:postgres', 'after-start:postgres', 'after-start:php']) {
  test('interrupted data recovery resumes without repeating imports or starts: ' + point, () => fixture(directory => {
    failedUpgrade(directory)
    change(directory, { kill: point })
    assert.equal(execute(directory, 'restoreRelease', restoreCode).signal, 'SIGKILL')
    change(directory, { kill: null })
    const result = execute(directory, 'restoreRelease', restoreCode)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(read(directory).calls.filter(call => call === 'restore-database').length, 1)
    assert.equal(read(directory).calls.filter(call => call === 'restore-files').length, 1)
  }))
}

test('restoration never guesses while a migration is still running', () => fixture(directory => {
  change(directory, { restoreMode: true, kill: 'after-start:release-migration' })
  assert.equal(execute(directory, 'continueRelease').signal, 'SIGKILL')
  change(directory, { kill: null, calls: [] })
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  assert.equal(read(directory).calls.includes('restore-database'), false)
  assert.equal(state(directory).operation.phase, 'recovery_required')
}))

test('unbacked queued messages block recovery rather than being purged or replayed against restored data', () => fixture(directory => {
  failedUpgrade(directory)
  change(directory, { queued: true })
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  assert.equal(read(directory).calls.includes('restore-database'), false)
  assert.equal(state(directory).operation.phase, 'recovery_required')
}))

test('restored data cannot be committed without matching container/readiness evidence', () => fixture(directory => {
  failedUpgrade(directory)
  change(directory, { fail: 'dependencies' })
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  const value = read(directory);value.fail = null;value.containers.postgres.Id = 'f'.repeat(64);change(directory, value)
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  assert.equal(state(directory).operation.phase, 'recovery_required')
  assert.equal(state(directory).data, undefined)
}))

test('state persistence refuses recovery completion without restored/readiness evidence', () => fixture(directory => {
  failedUpgrade(directory)
  change(directory, { fail: 'dependencies' })
  assert.equal(execute(directory, 'restoreRelease', restoreCode).status, 1)
  const module = new URL('./state.mjs', import.meta.url).href
  const code = restoreCode + "const {persist,recoveryTransition}=await import(" + JSON.stringify(module) + ");const s=JSON.parse(fs.readFileSync(directory+'/state.json'));persist(directory,s,recoveryTransition(s,'recovery_complete',{postgres:'unverified-pg',minio:'unverified-minio'}));"
  assert.equal(execute(directory, 'restoreRelease', code).status, 1)
  assert.equal(state(directory).operation.phase, 'recovery_required')
  assert.equal(state(directory).data, undefined)
}))

const older = { ...baseline.current, images: { php: manifest.images.php.replace('b'.repeat(64), 'd'.repeat(64)),
  nginx: manifest.images.nginx.replace('c'.repeat(64), 'e'.repeat(64)) } }
test('recovery starts the archived current manifest images rather than the failed candidate', () => fixture(directory => {
  failedUpgrade(directory)
  const result = execute(directory, 'restoreRelease', restoreCode)
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(state(directory).current, older)
  assert.equal(read(directory).containers.php.Image, 'sha256:' + 'd'.repeat(64))
  assert.equal(read(directory).containers.nginx.Image, 'sha256:' + 'e'.repeat(64))
}, 'public-fixture', older))

for (const point of ['verified', 'committed']) {
  test('interrupted recovery state publication resumes with coherent pointers: ' + point, () => fixture(directory => {
    failedUpgrade(directory)
    const code = restoreCode + (point === 'verified'
      ? "const link=fs.linkSync;fs.linkSync=(a,b)=>{link(a,b);if(b.endsWith('/verified.json'))process.kill(process.pid,'SIGKILL')};"
      : "const rename=fs.renameSync;fs.renameSync=(a,b)=>{rename(a,b);if(b.endsWith('/state.json')&&!JSON.parse(fs.readFileSync(b)).operation)process.kill(process.pid,'SIGKILL')};")
    assert.equal(execute(directory, 'restoreRelease', code).signal, 'SIGKILL')
    const result = execute(directory, 'restoreRelease', restoreCode)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(state(directory).operation, null)
    assert.deepEqual(state(directory).current, baseline.current)
    assert.equal(read(directory).calls.filter(call => call === 'restore-database').length, 1)
  }))
}

test('recover uses the same nonblocking CLI lock as deploy and rollback', () => fixture(async directory => {
  const holder = spawn('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;echo locked;read done'], { env: { PATH: process.env.PATH, TEST_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve);holder.once('error', reject) })
    const result = spawnSync('sh', [fileURLToPath(new URL('./release.sh', import.meta.url)), 'recover', directory, 'unused', 'unused', 'unused', 'unused', join(directory, 'backup'), 'source', 'runtime'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.deepEqual(read(directory).calls, [])
  } finally {
    const exited = new Promise(resolve => holder.once('exit', resolve));holder.stdin.end('done\n');await exited
  }
}))
