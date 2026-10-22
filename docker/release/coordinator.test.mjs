import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { create } from './manifest.mjs'
import { advance, begin, initialState } from './state.mjs'
import { DockerCoordinator, writerOrder } from './coordinator-docker.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const coordinatorUrl = new URL('./coordinator.mjs', import.meta.url).href
const fakeUrl = new URL('./coordinator-test-support.mjs', import.meta.url).href
const manifest = create({ CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123',
  PHP_IMAGE: 'registry.example.test/pizza/php@sha256:' + 'b'.repeat(64), NGINX_IMAGE: 'registry.example.test/pizza/nginx@sha256:' + 'c'.repeat(64) })
const baseline = { ...initialState('pizza-backup-test'), revision: 10,
  current: create({ ...{ CI_COMMIT_SHA: 'd'.repeat(40), CI_PIPELINE_ID: '122' }, PHP_IMAGE: manifest.images.php, NGINX_IMAGE: manifest.images.nginx }) }

function fixture(run) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-coordinator-'))
  try {
    fs.mkdirSync(join(directory, 'backup'), { mode: 0o700 })
    fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(baseline), { mode: 0o600 })
    fs.writeFileSync(join(directory, 'manifest.json'), JSON.stringify(manifest))
    fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ calls: [], stops: [], writers: writerOrder.map((service, index) => ({
      id: String(index + 1).repeat(64), service, image: 'sha256:' + 'e'.repeat(64), started_at: '2026-10-16T01:00:00Z', running: true, exit_code: 0, oom: false,
    })) }))
    return run(directory)
  } finally { fs.rmSync(directory, { recursive: true }) }
}
function read(directory, file = 'fixture.json') { return JSON.parse(fs.readFileSync(join(directory, file), 'utf8')) }
function change(directory, values) { fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ ...read(directory), ...values })) }
function stateBytes(directory) { return fs.readFileSync(join(directory, 'state.json'), 'utf8') }
function execute(directory, code = '') {
  return spawnSync('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY"; flock -n -x 9; exec node --input-type=module -e "$TEST_CODE"'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, TEST_DIRECTORY: directory, TEST_CODE: `
      import fs from 'node:fs';
      import {fixtureFailure} from ${JSON.stringify(new URL('./release-test-diagnostics.mjs', import.meta.url).href)};
      import {prepareBackup} from ${JSON.stringify(coordinatorUrl)};
      import {FakeCoordinator} from ${JSON.stringify(fakeUrl)};
      const directory=process.env.TEST_DIRECTORY;
      const manifest=JSON.parse(fs.readFileSync(directory+'/manifest.json','utf8'));
      const driver=new FakeCoordinator(directory+'/fixture.json');
      ${code}
      try { prepareBackup(directory,manifest,'unused-bundle','unused-runtime',directory+'/backup',driver) }
      catch(error) {process.stderr.write(fixtureFailure(error, 'prepareBackup'));process.exitCode=1}
    ` },
  })
}

test('prepare-backup checks before pulling/stopping, preserves releases and retries quiesced without another stop', () => fixture(directory => {
  const result = execute(directory)
  assert.equal(result.status, 0, result.stderr)
  const state = read(directory, 'state.json'), data = read(directory)
  assert.equal(state.operation.phase, 'quiesced')
  assert.equal(state.revision, baseline.revision + 4)
  assert.deepEqual(state.current, baseline.current)
  assert.equal(state.previous, baseline.previous)
  assert.deepEqual(data.stops, writerOrder)
  assert.ok(data.calls.indexOf('check') < data.calls.indexOf('pull:php'))
  assert.ok(data.calls.indexOf('tools') < data.calls.indexOf('stop:nginx'))
  const plan = fs.readdirSync(directory).find(name => name.startsWith('quiesce-'))
  assert.equal(fs.readFileSync(join(directory, plan), 'utf8').includes('controlled-secret-canary'), false)
  assert.equal(fs.statSync(join(directory, plan)).mode & 0o777, 0o600)
  const before = stateBytes(directory)
  change(directory, { calls: [] })
  assert.equal(execute(directory).status, 0)
  assert.equal(stateBytes(directory), before)
  assert.deepEqual(read(directory).stops, writerOrder)
  assert.equal(read(directory).calls.some(name => name.startsWith('pull:') || name.startsWith('stop:')), false)
}))

for (const failure of ['check', 'snapshot', 'pull:php', 'image:php', 'pull:nginx', 'image:nginx', 'inventory', 'tools', 'estimate']) {
  test(`${failure} failure never stops writers; same release can resume`, () => fixture(directory => {
    change(directory, { fail: failure })
    assert.equal(execute(directory).status, 1)
    assert.deepEqual(read(directory).stops, [])
    assert.deepEqual(read(directory, 'state.json').current, baseline.current)
    const phase = read(directory, 'state.json').operation?.phase
    assert.equal(phase, ['check', 'snapshot'].includes(failure) ? undefined : failure.startsWith('pull:') || failure.startsWith('image:') ? 'prepared' : 'images_ready')
    change(directory, { fail: null })
    assert.equal(execute(directory).status, 0)
    assert.equal(read(directory, 'state.json').operation.phase, 'quiesced')
  }))
}

for (const service of writerOrder) {
  test(`stop failure at ${service} leaves quiescing and resumes only remaining running writers`, () => fixture(directory => {
    change(directory, { fail: `stop:${service}` })
    assert.equal(execute(directory).status, 1)
    assert.equal(read(directory, 'state.json').operation.phase, 'quiescing')
    assert.deepEqual(read(directory).stops, writerOrder.slice(0, writerOrder.indexOf(service)))
    change(directory, { fail: null })
    assert.equal(execute(directory).status, 0)
    assert.deepEqual(read(directory).stops, writerOrder)
  }))
}

for (const failure of ['bad_exit', 'oom']) {
  test(`${failure} blocks subsequent writers and remains blocked on retry`, () => fixture(directory => {
    change(directory, { [failure]: 'report-scheduler' })
    assert.equal(execute(directory).status, 1)
    assert.deepEqual(read(directory).stops, ['nginx', 'report-scheduler'])
    assert.equal(read(directory, 'state.json').operation.phase, 'quiescing')
    const before = stateBytes(directory)
    assert.equal(execute(directory).status, 1)
    assert.equal(stateBytes(directory), before)
    assert.deepEqual(read(directory).stops, ['nginx', 'report-scheduler'])
  }))
}

test('disk shortage, public backup root and state directory block stopping', () => fixture(directory => {
  change(directory, { space_failure: true })
  assert.equal(execute(directory).status, 1)
  assert.equal(read(directory, 'state.json').operation.phase, 'images_ready')
  assert.deepEqual(read(directory).stops, [])
  change(directory, { space_failure: false })
  fs.chmodSync(join(directory, 'backup'), 0o755)
  assert.equal(execute(directory).status, 1)
  fs.chmodSync(join(directory, 'backup'), 0o700)
  fs.chmodSync(directory, 0o755)
  const before = stateBytes(directory)
  assert.equal(execute(directory).status, 1)
  assert.equal(stateBytes(directory), before)
  assert.deepEqual(read(directory).stops, [])
}))

for (const failure of ['started_at', 'id', 'image', 'configuration', 'missing-plan', 'corrupt-plan', 'foreign-plan']) {
  test(`retry rejects ${failure} changes without stopping more writers`, () => fixture(directory => {
    change(directory, { fail: 'stop:report-scheduler' })
    assert.equal(execute(directory).status, 1)
    const data = read(directory)
    if (['started_at', 'id', 'image'].includes(failure)) data.writers[1][failure] += 'changed'
    if (failure === 'configuration') data.configuration = 2
    change(directory, { ...data, fail: null })
    const plan = fs.readdirSync(directory).find(name => name.startsWith('quiesce-'))
    if (failure === 'missing-plan') fs.unlinkSync(join(directory, plan))
    if (failure === 'corrupt-plan') fs.writeFileSync(join(directory, plan), '{bad')
    if (failure === 'foreign-plan') {
      const value = read(directory, plan); value.project = 'other'; fs.writeFileSync(join(directory, plan), JSON.stringify(value))
    }
    const before = stateBytes(directory)
    assert.equal(execute(directory).status, 1)
    assert.equal(stateBytes(directory), before)
    assert.deepEqual(read(directory).stops, ['nginx'])
  }))
}

test('final inventory failure leaves quiescing and can retry without repeating actual stops', () => fixture(directory => {
  change(directory, { fail: 'stopped-inventory' })
  assert.equal(execute(directory).status, 1)
  assert.equal(read(directory, 'state.json').operation.phase, 'quiescing')
  assert.deepEqual(read(directory).stops, writerOrder)
  change(directory, { fail: null })
  assert.equal(execute(directory).status, 0)
  assert.deepEqual(read(directory).stops, writerOrder)
}))

test('state write failures never stop writers before quiescing is durably recorded', () => fixture(directory => {
  for (const phase of ['prepared', 'images_ready', 'quiescing']) {
    fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(baseline))
    change(directory, { calls: [], stops: [] })
    const result = execute(directory, `const rename=fs.renameSync;fs.renameSync=(src,dst)=>{if(JSON.parse(fs.readFileSync(src)).operation.phase===${JSON.stringify(phase)})throw new Error('controlled');return rename(src,dst)};`)
    assert.equal(result.status, 1)
    assert.deepEqual(read(directory).stops, [])
  }
}))

test('wrong project, conflicting release, missing/corrupt state and later phases fail before adapter operations', () => fixture(directory => {
  for (const contents of ['{bad', JSON.stringify({ ...baseline, project: 'other' }), JSON.stringify(begin(baseline, { ...manifest, pipeline_id: '999' }))]) {
    fs.writeFileSync(join(directory, 'state.json'), contents)
    change(directory, { calls: [] })
    assert.equal(execute(directory).status, 1)
    assert.deepEqual(read(directory).calls, [])
    assert.equal(stateBytes(directory), contents)
  }
  let state = begin(baseline, manifest)
  for (const phase of ['images_ready', 'quiescing', 'quiesced', 'backup_ready', 'migrating', 'migrated', 'starting', 'verified']) {
    state = advance(state, manifest, phase)
    if (['images_ready', 'quiescing', 'quiesced'].includes(phase)) continue
    fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(state))
    assert.equal(execute(directory).status, 1)
    assert.deepEqual(read(directory).calls, [])
  }
  fs.unlinkSync(join(directory, 'state.json'))
  assert.equal(execute(directory).status, 1)
  assert.equal(fs.existsSync(join(directory, 'state.json')), false)
}))

test('already current release performs only read-only configuration check', () => fixture(directory => {
  fs.writeFileSync(join(directory, 'state.json'), JSON.stringify({ ...baseline, current: manifest }))
  const before = stateBytes(directory)
  assert.equal(execute(directory).status, 0)
  assert.equal(stateBytes(directory), before)
  assert.deepEqual(read(directory).calls, ['check'])
}))

function adapterFixture() {
  const driver = new DockerCoordinator({ project: 'pizza-backup-test', utility_image: 'sha256:' + 'e'.repeat(64) })
  const containers = writerOrder.map((service, index) => ({ Id: String(index + 1).repeat(64), Image: 'sha256:' + 'e'.repeat(64),
    Config: { Labels: { 'com.docker.compose.project': 'pizza-backup-test', 'com.docker.compose.service': service } },
    State: { Running: true, Status: 'running', Paused: false, Restarting: false, Dead: false, OOMKilled: false, ExitCode: 0, StartedAt: '2026-10-16T01:00:00Z' } }))
  driver.backup.inspect = id => structuredClone(containers.find(container => container.Id === id))
  driver.backup.inventory = () => containers.map(item => [item.Id])
  const calls = []
  driver.backup.run = args => {
    calls.push(args)
    if (args[0] === 'version') return JSON.stringify({ Os: 'linux', Arch: 'amd64' })
    if (args[0] === 'image') return JSON.stringify([{ Id: 'sha256:' + 'e'.repeat(64), RepoDigests: [args.at(-1)], Os: 'linux', Architecture: 'amd64' }])
    if (args[0] === 'stop') {
      const container = containers.find(item => item.Id === args[1])
      container.State.Running = false; container.State.Status = 'exited'
    }
    return ''
  }
  return { driver, containers, calls }
}

test('Docker adapter pulls only immutable manifest refs and stops only inspected IDs in the local daemon', () => {
  const { driver, containers, calls } = adapterFixture()
  driver.images(manifest, true)
  assert.deepEqual(calls.filter(args => args[0] === 'pull'), Object.values(manifest.images).map(ref => ['pull', '--quiet', ref]))
  const writer = driver.snapshot(initialState('pizza-backup-test'))[0]
  driver.stop(writer, 'pizza-backup-test')
  driver.stop(writer, 'pizza-backup-test')
  assert.deepEqual(calls.filter(args => args[0] === 'stop'), [['stop', containers[0].Id]])
  assert.equal(driver.backup.env.DOCKER_HOST, 'unix:///var/run/docker.sock')
})

for (const change of [{ ExitCode: 124 }, { ExitCode: 137 }, { ExitCode: 1 }, { OOMKilled: true }, { Running: true }, { Paused: true }, { Restarting: true }]) {
  test(`Docker stop inspects actual status and rejects ${JSON.stringify(change)}`, () => {
    const { driver, containers } = adapterFixture()
    const writer = driver.snapshot(initialState('pizza-backup-test'))[0]
    driver.backup.run = args => {
      assert.equal(args[0], 'stop')
      Object.assign(containers[0].State, { Running: false, Status: 'exited' }, change)
      return ''
    }
    assert.throws(() => driver.stop(writer, 'pizza-backup-test'))
  })
}

test('foreign labels, restarted/replaced containers and missing digest fail closed', () => {
  for (const change of [container => { container.Config.Labels['com.docker.compose.project'] = 'other' },
    container => { container.State.StartedAt = 'new' }, container => { container.Image = 'sha256:' + 'f'.repeat(64) }]) {
    const { driver, containers, calls } = adapterFixture()
    const writer = driver.snapshot(initialState('pizza-backup-test'))[0]
    change(containers[0])
    assert.throws(() => driver.stop(writer, 'pizza-backup-test'))
    assert.equal(calls.some(args => args[0] === 'stop'), false)
  }
  const { driver } = adapterFixture()
  driver.backup.run = args => args[0] === 'version' ? JSON.stringify({ Os: 'linux', Arch: 'amd64' }) : JSON.stringify([{ Id: 'sha256:' + 'e'.repeat(64), RepoDigests: [], Os: 'linux', Architecture: 'amd64' }])
  assert.throws(() => driver.images(manifest))
})

test('CLI rejects invalid arguments/manifest before Docker and sanitizes errors', () => fixture(directory => {
  const settings = { schema_version: 1, project: 'pizza-backup-test', postgres_container: '1'.repeat(64), minio_container: '2'.repeat(64), utility_image: 'sha256:' + 'e'.repeat(64), reserve_bytes: 67108864 }
  fs.writeFileSync(join(directory, 'settings.json'), JSON.stringify(settings))
  fs.writeFileSync(join(directory, 'manifest.json'), '{"controlled-secret-canary":')
  const args = ['prepare-backup', directory, join(directory, 'manifest.json'), directory, '/unused/runtime', join(directory, 'settings.json'), join(directory, 'backup')]
  const before = stateBytes(directory)
  for (const input of [args, args.slice(0, -1), [...args, 'extra'], ['unknown', ...args.slice(1)]]) {
    const result = spawnSync('sh', [join(root, 'docker/release/release.sh'), ...input], { encoding: 'utf8', env: { PATH: process.env.PATH } })
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('controlled-secret-canary'), false)
    assert.equal(stateBytes(directory), before)
  }
}))

test('concurrent coordinator refuses the shared release lock', async () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-coordinator-lock-'))
  const holder = spawn('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;echo locked;read done'], {
    env: { PATH: process.env.PATH, TEST_DIRECTORY: directory }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('error', reject); holder.once('exit', () => reject(new Error('Lock holder exited'))) })
    const result = spawnSync('sh', [join(root, 'docker/release/release.sh'), 'prepare-backup', directory, 'unused', 'unused', 'unused', 'unused', 'unused'], { encoding: 'utf8' })
    assert.equal(result.status, 1)
    assert.deepEqual(fs.readdirSync(directory), [])
  } finally {
    const exited = new Promise(resolve => holder.once('exit', resolve)); holder.stdin.end('done\n'); await exited
    fs.rmSync(directory, { recursive: true })
  }
})

test('SIGKILL after a successful stop resumes from the durable plan without stopping it again', () => fixture(directory => {
  const result = execute(directory, `const stop=driver.stop.bind(driver);driver.stop=(writer,...args)=>{stop(writer,...args);if(writer.service==='report-scheduler')process.kill(process.pid,'SIGKILL')};`)
  assert.notEqual(result.status, 0)
  assert.equal(read(directory, 'state.json').operation.phase, 'quiescing')
  assert.deepEqual(read(directory).stops, ['nginx', 'report-scheduler'])
  assert.equal(execute(directory).status, 0)
  assert.deepEqual(read(directory).stops, writerOrder)
}))

test('failed plan publication blocks stops and can retry; failed quiesced persistence does not repeat actual stops', () => fixture(directory => {
  assert.equal(execute(directory, `fs.linkSync=()=>{throw new Error('controlled')};`).status, 1)
  assert.equal(read(directory, 'state.json').operation.phase, 'images_ready')
  assert.deepEqual(read(directory).stops, [])
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.quiesce-')), false)
  assert.equal(execute(directory, `const rename=fs.renameSync;fs.renameSync=(src,dst)=>{if(JSON.parse(fs.readFileSync(src)).operation.phase==='quiesced')throw new Error('controlled');return rename(src,dst)};`).status, 1)
  assert.equal(read(directory, 'state.json').operation.phase, 'quiescing')
  assert.deepEqual(read(directory).stops, writerOrder)
  assert.equal(execute(directory).status, 0)
  assert.deepEqual(read(directory).stops, writerOrder)
}))

test('changed backup settings on retry fail before additional stops', () => fixture(directory => {
  change(directory, { fail: 'stop:report-scheduler' })
  assert.equal(execute(directory).status, 1)
  change(directory, { fail: null })
  assert.equal(execute(directory, 'driver.backup.config.reserve_bytes+=1;').status, 1)
  assert.deepEqual(read(directory).stops, ['nginx'])
}))

test('invalid manifest references are rejected by Docker adapter before any pull', () => {
  const { driver, calls } = adapterFixture()
  assert.throws(() => driver.images({ ...manifest, images: { ...manifest.images, php: 'registry.example.test/pizza/php:latest' } }, true))
  assert.deepEqual(calls, [])
})

test('source release drift and duplicate optional writers fail inventory before stopping', () => {
  const { driver, containers, calls } = adapterFixture()
  containers[0].Image = 'sha256:' + 'f'.repeat(64)
  assert.throws(() => driver.snapshot(baseline))
  assert.equal(calls.some(args => args[0] === 'stop'), false)
  const other = adapterFixture()
  other.containers.push(structuredClone({ ...other.containers[5], Id: '8'.repeat(64) }))
  assert.throws(() => other.driver.snapshot(initialState('pizza-backup-test')))
})

test('Docker configuration checks use the local daemon environment and suppress child errors', () => fixture(directory => {
  const { driver } = adapterFixture()
  const config = { name: baseline.project, services: Object.fromEntries(['php', 'report-worker', 'outbox-worker', 'report-scheduler', 'nginx'].map(service => [service, {
    image: manifest.images[service === 'nginx' ? 'nginx' : 'php'], environment: { APP_ENV: 'production', APP_DEBUG: 'false' },
  }])) }
  const callsFile = join(directory, 'docker-calls.json')
  const shimPath = join(directory, 'docker-shim.cjs')
  fs.writeFileSync(shimPath, `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(callsFile)},JSON.stringify({args:process.argv.slice(2),host:process.env.DOCKER_HOST,profiles:process.env.COMPOSE_PROFILES,php:process.env.PHP_IMAGE}));
console.log(${JSON.stringify(JSON.stringify(config))});
`)
  const quote = value => "'" + value.replaceAll("'", "'\"'\"'") + "'"
  fs.writeFileSync(join(directory, 'docker'), `#!/bin/sh\nexec ${quote(process.execPath)} -- ${quote(shimPath)} "$@"\n`, { mode: 0o700 })
  driver.backup.env.PATH = directory
  assert.deepEqual(driver.check(baseline, manifest, directory, '/unused/runtime'), config)
  const calls = read(directory, 'docker-calls.json')
  assert.equal(calls.host, 'unix:///var/run/docker.sock')
  assert.equal(calls.profiles, '')
  assert.equal(calls.php, manifest.images.php)
  assert.deepEqual(calls.args.slice(-3), ['config', '--format', 'json'])
  fs.writeFileSync(join(directory, 'docker'), '#!/bin/sh\necho controlled-secret-canary >&2\nexit 42\n', { mode: 0o700 })
  assert.throws(() => driver.check(baseline, manifest, directory, '/unused/runtime'), error => !error.message.includes('controlled-secret-canary'))
}))

test('Docker adapter rejects a candidate image built for another OS or architecture', () => {
  for (const platform of [{ Os: 'linux', Architecture: 'arm64' }, { Os: 'windows', Architecture: 'amd64' }]) {
    const { driver } = adapterFixture()
    driver.backup.run = args => args[0] === 'version' ? JSON.stringify({ Os: 'linux', Arch: 'amd64' })
      : JSON.stringify([{ Id: 'sha256:' + 'e'.repeat(64), RepoDigests: [args.at(-1)], ...platform }])
    assert.throws(() => driver.images(manifest))
  }
})

test('stop command failure after the container actually exited is safe to repeat', () => {
  const { driver, containers, calls } = adapterFixture()
  const writer = driver.snapshot(initialState('pizza-backup-test'))[0]
  const run = driver.backup.run
  driver.backup.run = args => { run(args); throw new Error('controlled Docker response failure') }
  assert.throws(() => driver.stop(writer, 'pizza-backup-test'))
  assert.equal(containers[0].State.Running, false)
  driver.backup.run = run
  driver.stop(writer, 'pizza-backup-test')
  assert.deepEqual(calls.filter(args => args[0] === 'stop'), [['stop', writer.id]])
})
