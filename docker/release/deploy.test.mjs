import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { create } from './manifest.mjs'
import { advance, begin, checkCandidate, checkCompose, composeProcessEnvironment, identity, initialState, readState, validateState } from './state.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const moduleUrl = new URL('./state.mjs', import.meta.url).href
const evidenceUrl = new URL('./backup-test-support.mjs', import.meta.url).href
const source = {
  CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123',
  PHP_IMAGE: `registry.example.test/project/php@sha256:${'b'.repeat(64)}`,
  NGINX_IMAGE: `registry.example.test/project/nginx@sha256:${'c'.repeat(64)}`,
}
const first = create(source)
const second = create({ ...source, CI_PIPELINE_ID: '124', CI_COMMIT_SHA: 'd'.repeat(40) })
const steps = ['images_ready', 'quiescing', 'quiesced', 'backup_ready', 'migrating', 'migrated', 'starting', 'verified', 'committed']
function completed(state, manifest) {
  return steps.reduce((value, phase) => advance(value, manifest, phase), begin(state, manifest))
}
function fixture() { return fs.mkdtempSync(join(tmpdir(), 'pizza-state-test-')) }
function writeFixture(directory, state) {
  fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(state), { flag: 'wx', mode: 0o600 })
}
function execute(directory, code, additions = {}) {
  return spawnSync('sh', ['-c', 'exec 9<"$TEST_DIR"; exec node --input-type=module -e "$TEST_CODE"'], {
    encoding: 'utf8', env: { PATH: process.env.PATH, TEST_DIR: directory,
      TEST_CODE: `import {stateEvidence} from ${JSON.stringify(evidenceUrl)}; import fs from 'node:fs'; import {persist,readState,initialState,begin,advance} from ${JSON.stringify(moduleUrl)}; ${code}`, ...additions },
  })
}

test('phase transitions, repeat releases and manifest conflicts fail closed', () => {
  const empty = initialState('pizza-production')
  assert.throws(() => validateState({ ...empty, extra: true }))
  assert.throws(() => validateState({ ...empty, previous: first }))
  assert.throws(() => validateState({ ...empty, revision: -1 }))
  assert.throws(() => advance(empty, first, 'migrating'))
  const pending = begin(empty, first)
  assert.deepEqual(begin(pending, first), pending)
  assert.throws(() => advance(pending, first, 'migrated'))
  assert.throws(() => begin(pending, second))
  assert.throws(() => checkCandidate(pending, create({ ...source, PHP_IMAGE: source.PHP_IMAGE.replace('b'.repeat(64), 'e'.repeat(64)) })))
  const a = completed(empty, first)
  const b = completed(a, second)
  assert.deepEqual(b.current, second)
  assert.deepEqual(b.previous, first)
  assert.deepEqual(begin(b, second), b)
  assert.throws(() => begin(b, first))
  assert.equal(identity(first), identity(JSON.parse(JSON.stringify(first))))
})

test('state schema rejects every missing field, unknown phase and invalid revision without recovery', () => {
  const directory = fixture()
  try {
    const base = begin(initialState('pizza-production'), first)
    const invalid = ['{public-canary', 'null', '[]']
    for (const field of Object.keys(base)) {
      const value = structuredClone(base)
      delete value[field]
      invalid.push(JSON.stringify(value))
    }
    for (const field of ['manifest', 'phase']) {
      const value = structuredClone(base)
      delete value.operation[field]
      invalid.push(JSON.stringify(value))
    }
    for (const change of [
      { operation: { manifest: first, phase: 'unknown' } },
      { operation: { manifest: first, phase: 'committed' } },
      { revision: '1' }, { revision: -1 }, { revision: 1.5 }, { revision: Number.MAX_SAFE_INTEGER + 1 },
      { project: '' }, { project: 'Invalid project' }, { schema_version: 2 },
    ]) invalid.push(JSON.stringify({ ...base, ...change }))
    const file = join(directory, 'state.json')
    for (const contents of invalid) {
      fs.writeFileSync(file, contents)
      assert.throws(() => readState(directory))
      const status = spawnSync('sh', [join(root, 'docker/release/release.sh'), 'status', directory], {
        encoding: 'utf8', env: { PATH: process.env.PATH },
      })
      assert.equal(status.status, 1)
      assert.equal((status.stdout + status.stderr).includes('public-canary'), false)
      assert.equal(fs.readFileSync(file, 'utf8'), contents)
      assert.deepEqual(fs.readdirSync(directory), ['state.json'])
    }
    for (const phase of ['prepared', 'verified', 'unknown']) assert.throws(() => advance(base, first, phase))
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('atomic persistence requires lock and expected state; never resets existing/corrupt state', () => {
  const directory = fixture()
  try {
    const init = 'persist(process.env.TEST_DIR,null,initialState("pizza-production"));'
    const unlocked = spawnSync(process.execPath, ['--input-type=module', '-e',
      `import {persist,initialState} from ${JSON.stringify(moduleUrl)};persist(${JSON.stringify(directory)},null,initialState('pizza-production'));`], { encoding: 'utf8' })
    assert.notEqual(unlocked.status, 0)
    assert.equal(fs.existsSync(join(directory, 'state.json')), false)
    assert.equal(execute(directory, init).status, 0)
    const original = fs.readFileSync(join(directory, 'state.json'), 'utf8')
    assert.notEqual(execute(directory, init).status, 0)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), original)
    const manifest = JSON.stringify(first)
    assert.equal(execute(directory, `const s=readState(process.env.TEST_DIR);persist(process.env.TEST_DIR,s,begin(s,${manifest}));`).status, 0)
    const pending = fs.readFileSync(join(directory, 'state.json'), 'utf8')
    assert.notEqual(execute(directory, `const s=initialState("pizza-production");persist(process.env.TEST_DIR,s,begin(s,${manifest}));`).status, 0)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), pending)
    assert.notEqual(execute(directory, 'const s=readState(process.env.TEST_DIR);persist(process.env.TEST_DIR,s,{...s,project:"other"});').status, 0)
    fs.writeFileSync(join(directory, 'state.json'), '{interrupted')
    assert.notEqual(execute(directory, init).status, 0)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), '{interrupted')
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('write and rename failures preserve current/previous and remove staged files', () => {
  const directory = fixture()
  try {
    writeFixture(directory, completed(completed(initialState('pizza-production'), first), second))
    const third = create({ ...source, CI_PIPELINE_ID: '125' })
    const original = fs.readFileSync(join(directory, 'state.json'), 'utf8')
    for (const failure of ['write', 'rename']) {
      const code = `const s=readState(process.env.TEST_DIR);const n=begin(s,${JSON.stringify(third)});
        ${failure === 'write'
          ? 'const write=fs.writeFileSync;fs.writeFileSync=(p,c,o)=>{write(p,c.slice(0,5),o);throw new Error("test failure")};'
          : 'fs.renameSync=()=>{throw new Error("test failure")};'}
        try{persist(process.env.TEST_DIR,s,n);process.exitCode=99}catch{process.exitCode=42}`
      assert.equal(execute(directory, code).status, 42)
      assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), original)
      assert.deepEqual(fs.readdirSync(directory), ['state.json'])
    }
    // Simulated abrupt death leaves a private orphan, never a partially published state.
    const interrupted = execute(directory, `const s=readState(process.env.TEST_DIR);fs.renameSync=()=>{process.kill(process.pid,'SIGKILL')};persist(process.env.TEST_DIR,s,begin(s,${JSON.stringify(third)}));`)
    assert.notEqual(interrupted.status, 0)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), original)
    assert.ok(fs.readdirSync(directory).some(name => name.startsWith('.state-')))
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('successful persistence commits current/previous together and repeat begin is a no-op', () => {
  const directory = fixture()
  try {
    writeFixture(directory, completed(initialState('pizza-production'), first))
    const result = execute(directory, `
      let s=readState(process.env.TEST_DIR);
      let n=begin(s,${JSON.stringify(second)});persist(process.env.TEST_DIR,s,n);s=n;
      for(const phase of ${JSON.stringify(steps)}) {
        n=advance(s,${JSON.stringify(second)},phase);persist(process.env.TEST_DIR,s,n,stateEvidence(process.env.TEST_DIR,s,n));s=n;
      }
      const bytes=fs.readFileSync(process.env.TEST_DIR+'/state.json','utf8');
      persist(process.env.TEST_DIR,s,begin(s,${JSON.stringify(second)}));
      if(fs.readFileSync(process.env.TEST_DIR+'/state.json','utf8')!==bytes)process.exit(42);
    `)
    assert.equal(result.status, 0, result.stderr)
    const stored = JSON.parse(fs.readFileSync(join(directory, 'state.json')))
    assert.deepEqual(stored.current, second)
    assert.deepEqual(stored.previous, first)
    assert.equal(stored.operation, null)
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('active begin/persist repeats preserve bytes and still reject stale/conflicting states', () => {
  const directory = fixture()
  try {
    writeFixture(directory, begin(initialState('pizza-production'), first))
    const result = execute(directory, `
      import assert from 'node:assert/strict';
      const manifest=${JSON.stringify(first)}, conflict=${JSON.stringify({ ...first, git_sha: 'e'.repeat(40), deployment_config: { version: 1, git_sha: 'e'.repeat(40) } })};
      let s=readState(process.env.TEST_DIR);
      const stale=structuredClone(s);
      for(const phase of ['prepared','images_ready','migrating','verified']) {
        while(s.operation.phase!==phase) {
          const phases=['prepared',...${JSON.stringify(steps)}];
          const n=advance(s,manifest,phases[phases.indexOf(s.operation.phase)+1]);
          persist(process.env.TEST_DIR,s,n,stateEvidence(process.env.TEST_DIR,s,n));s=n;
        }
        const before=fs.readFileSync(process.env.TEST_DIR+'/state.json','utf8');
        persist(process.env.TEST_DIR,s,begin(s,manifest));
        assert.throws(()=>begin(s,conflict));
        assert.throws(()=>persist(process.env.TEST_DIR,s,{...s,operation:{...s.operation,manifest:conflict}}));
        assert.throws(()=>persist(process.env.TEST_DIR,s,{...s,operation:{...s.operation,phase:'committed'}}));
        assert.throws(()=>persist(process.env.TEST_DIR,s,{...s,project:'other-project'}));
        assert.throws(()=>persist(process.env.TEST_DIR,s,{...s,revision:s.revision+2}));
        assert.throws(()=>persist(process.env.TEST_DIR,{...s,revision:s.revision+1},{...s,revision:s.revision+1}));
        if(phase!=='prepared')assert.throws(()=>persist(process.env.TEST_DIR,stale,stale));
        assert.equal(fs.readFileSync(process.env.TEST_DIR+'/state.json','utf8'),before);
      }
    `)
    assert.equal(result.status, 0, result.stderr)
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('SIGKILL before/after commit publication preserves a coherent current/previous pair', () => {
  const directory = fixture()
  try {
    let verified = begin(completed(initialState('pizza-production'), first), second)
    for (const phase of steps.slice(0, -1)) verified = advance(verified, second, phase)
    const committed = advance(verified, second, 'committed')
    for (const point of ['before', 'after', 'directory-fsync']) {
      fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(verified))
      const code = `
        const s=readState(process.env.TEST_DIR),n=advance(s,s.operation.manifest,'committed');
        const rename=fs.renameSync;
        fs.renameSync=(...args)=>{
          if(${JSON.stringify(point)}==='before')process.kill(process.pid,'SIGKILL');
          rename(...args);
          if(${JSON.stringify(point)}==='after')process.kill(process.pid,'SIGKILL');
        };
        if(${JSON.stringify(point)}==='directory-fsync') {
          const sync=fs.fsyncSync;
          fs.fsyncSync=(fd)=>{if(fs.fstatSync(fd).isDirectory())throw new Error('injected fsync failure');sync(fd)};
        }
        persist(process.env.TEST_DIR,s,n);
      `
      assert.notEqual(execute(directory, code).status, 0)
      const stored = readState(directory)
      assert.deepEqual(stored, point === 'before' ? verified : committed)
      assert.deepEqual(stored.current, point === 'before' ? first : second)
      assert.deepEqual(stored.previous, point === 'before' ? null : first)
      // A previously held lock is released even on abrupt process termination.
      const status = spawnSync('sh', [join(root, 'docker/release/release.sh'), 'status', directory], { encoding: 'utf8' })
      assert.equal(status.status, 0, status.stderr)
    }
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('two synchronized writers publish exactly one revision and reject the competing write', { timeout: 10000 }, async () => {
  const directory = fixture()
  const children = []
  try {
    const base = completed(completed(initialState('pizza-production'), first), second)
    writeFixture(directory, base)
    const candidates = ['125', '126'].map(CI_PIPELINE_ID => create({ ...source, CI_PIPELINE_ID }))
    for (const manifest of candidates) {
      const code = `import {persist,readState,begin} from ${JSON.stringify(moduleUrl)};
        const s=readState(process.env.TEST_DIR),n=begin(s,JSON.parse(process.env.TEST_MANIFEST));
        process.stdin.once('data',()=>{try{persist(process.env.TEST_DIR,s,n);process.exit(0)}catch{process.exit(42)}});
        process.stdout.write('ready\\n');`
      const child = spawn('sh', ['-c', 'exec 9<"$TEST_DIR"; exec node --input-type=module -e "$TEST_CODE"'], {
        env: { PATH: process.env.PATH, TEST_DIR: directory, TEST_CODE: code, TEST_MANIFEST: JSON.stringify(manifest) },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      const ready = new Promise((resolve, reject) => {
        child.stdout.once('data', resolve)
        child.once('error', reject)
        child.once('exit', code => reject(new Error(`Writer exited before barrier: ${code}`)))
      })
      const done = new Promise(resolve => child.once('close', resolve))
      children.push({ child, ready, done })
    }
    await Promise.all(children.map(entry => entry.ready))
    // Both processes have read the same expected revision before either writes.
    for (const entry of children) entry.child.stdin.end('go\n')
    const results = await Promise.all(children.map(entry => entry.done))
    assert.deepEqual([...results].sort((a, b) => a - b), [0, 42])
    const stored = readState(directory)
    const winner = candidates[results.indexOf(0)]
    assert.deepEqual(stored, begin(base, winner))
    assert.deepEqual(stored.current, base.current)
    assert.deepEqual(stored.previous, base.previous)
    assert.deepEqual(fs.readdirSync(directory), ['state.json'])
  } finally {
    for (const { child } of children) if (child.exitCode === null) child.kill('SIGKILL')
    await Promise.all(children.map(entry => entry.done))
    fs.rmSync(directory, { recursive: true })
  }
})

test('check validates the real three-file Compose bundle without a daemon or local env', () => {
  const directory = fixture()
  try {
    writeFixture(directory, initialState('existing-production-project'))
    for (const file of ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.release.yml']) {
      fs.copyFileSync(join(root, file), join(directory, file))
    }
    fs.writeFileSync(join(directory, '.env'), '')
    const values = {
      APP_URL: 'https://pizza.example.test', APP_KEY: 'public-test', JWT_SECRET: 'public-test', POSTGRES_DB: 'test', POSTGRES_USER: 'test',
      POSTGRES_PASSWORD: 'public-test', DB_CONNECTION: 'pgsql', DB_HOST: 'postgres', DB_PORT: '5432',
      DB_DATABASE: 'test', DB_USERNAME: 'test', DB_PASSWORD: 'public-test', REDIS_PASSWORD: 'public-test',
      RABBITMQ_USER: 'test', RABBITMQ_PASSWORD: 'public-test', MINIO_ROOT_USER: 'test',
      MINIO_ROOT_PASSWORD: 'public-test', MINIO_BUCKET: 'reports', NGINX_PORT: '8080', PRODUCTS_CACHE_TTL: '3600',
      POSTGRES_PORT: '5432', REDIS_PORT: '6379', RABBITMQ_PORT: '5672', RABBITMQ_MANAGEMENT_PORT: '15672',
      MINIO_PORT: '9000', MINIO_CONSOLE_PORT: '9001',
      MINIO_IMAGE: 'registry.example.test/project/minio-community@sha256:' + 'e'.repeat(64),
      MINIO_MC_IMAGE: 'registry.example.test/project/mc-community@sha256:' + 'f'.repeat(64),
    }
    const runtime = join(directory, 'runtime.env')
    fs.writeFileSync(runtime, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''))
    const manifest = join(directory, 'release.json')
    fs.writeFileSync(manifest, JSON.stringify(first))
    const realDocker = spawnSync('sh', ['-c', 'command -v docker'], { encoding: 'utf8' }).stdout.trim()
    assert.ok(realDocker.startsWith('/'))
    fs.symlinkSync(realDocker, join(directory, 'real-docker'))
    fs.writeFileSync(join(directory, 'docker'), '#!/bin/sh\nbase=$(dirname "$0")\n"$base/real-docker" "$@" > "$base/captured.json"\ncode=$?\ncat "$base/captured.json"\nexit "$code"\n')
    fs.chmodSync(join(directory, 'docker'), 0o700)
    const snapshot = () => Object.fromEntries(fs.readdirSync(directory)
      .filter(file => !['captured.json', 'real-docker'].includes(file))
      .map(file => [file, fs.readFileSync(join(directory, file), 'utf8')]))
    const before = snapshot()
    const result = spawnSync('sh', [join(root, 'docker/release/release.sh'), 'check', directory, manifest, directory, runtime], {
      encoding: 'utf8', env: { PATH: `${directory}:${process.env.PATH}`, COMPOSE_PROJECT_NAME: 'wrong', PHP_IMAGE: 'wrong',
        DB_HOST: 'wrong-host', DB_PORT: '6543', NGINX_PORT: '9999', POSTGRES_PORT: '9998', REDIS_PORT: '9997',
        RABBITMQ_PORT: '9996', MINIO_PORT: '9995', MINIO_IMAGE: 'wrong-server', MINIO_MC_IMAGE: 'wrong-client', COMPOSE_FILE: '/absent/override.yml' },
    })
    assert.equal(result.status, 0, result.stderr)
    const config = JSON.parse(fs.readFileSync(join(directory, 'captured.json'), 'utf8'))
    for (const name of ['php', 'report-worker', 'outbox-worker', 'report-scheduler']) {
      assert.equal(config.services[name].environment.DB_HOST, values.DB_HOST)
      assert.equal(config.services[name].environment.DB_PORT, values.DB_PORT)
    }
    assert.equal(config.services.minio.image, values.MINIO_IMAGE)
    assert.equal(config.services['minio-init'].image, values.MINIO_MC_IMAGE)
    assert.equal(config.services.nginx.ports[0].published, values.NGINX_PORT)
    for (const name of ['postgres', 'redis', 'rabbitmq', 'minio']) assert.equal(config.services[name].ports?.length || 0, 0)
    assert.deepEqual(snapshot(), before)
    const restoredConfig = checkCompose({ ...initialState('existing-production-project'), revision: 1, current: first,
      data: { postgres: 'pizza-recovered-test-pg', minio: 'pizza-recovered-test-minio' } }, first, directory, runtime,
    { PATH: directory + ':' + process.env.PATH })
    assert.equal(restoredConfig.volumes.pg_data_prod.name, 'pizza-recovered-test-pg')
    assert.equal(restoredConfig.volumes.minio_data_prod.name, 'pizza-recovered-test-minio')
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('Compose environment preserves CLI requirements and excludes application/shell overrides', () => {
  const cli = Object.fromEntries([
    'PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR', 'DOCKER_CONFIG', 'DOCKER_CONTEXT',
    'DOCKER_HOST', 'DOCKER_API_VERSION', 'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH',
    'SSH_AUTH_SOCK', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ].map(name => [name, `public-fixture-${name}`]))
  const input = { ...cli, DB_HOST: 'wrong', DB_PORT: '9999', NGINX_PORT: '9998', APP_KEY: 'public-canary',
    COMPOSE_FILE: 'wrong.yml', COMPOSE_PROJECT_NAME: 'wrong', COMPOSE_PROFILES: '*',
    PHP_IMAGE: 'wrong', NGINX_IMAGE: 'wrong', MINIO_IMAGE: 'wrong', MINIO_MC_IMAGE: 'wrong', NODE_OPTIONS: 'wrong' }
  assert.deepEqual(composeProcessEnvironment(input, first), {
    ...cli, COMPOSE_PROFILES: '', PHP_IMAGE: first.images.php, NGINX_IMAGE: first.images.nginx,
  })
})

test('status/check are read-only, bind images/project, sanitize errors and only execute Compose config', () => {
  const directory = fixture()
  try {
    writeFixture(directory, initialState('existing-production-project'))
    const manifest = join(directory, 'release.json')
    fs.writeFileSync(manifest, JSON.stringify(first))
    const runtime = join(directory, 'runtime.env')
    fs.writeFileSync(runtime, 'APP_KEY=public-canary\n')
    const calls = join(directory, 'docker.calls')
    const docker = join(directory, 'docker')
    // A fake Docker command records all calls. No daemon or network is involved.
    fs.writeFileSync(docker, `#!/bin/sh\nbase=$(dirname "$0")\nprintf '%s\\n' "$@" > "$base/docker.calls"\n[ ! -e "$base/docker.fail" ] || { echo public-canary; echo public-canary >&2; exit 1; }\ncat "$base/docker.config"\n`)
    fs.chmodSync(docker, 0o700)
    const config = { name: 'existing-production-project', services: Object.fromEntries(
      ['php', 'report-worker', 'outbox-worker', 'report-scheduler', 'nginx'].map(name => [name, {
        image: name === 'nginx' ? first.images.nginx : first.images.php,
        environment: { APP_ENV: 'production', APP_DEBUG: 'false' },
      }])) }
    config.services.minio = { image: 'registry.example.test/pizza/minio-community@sha256:' + 'e'.repeat(64) }
    config.services['minio-init'] = { image: 'registry.example.test/pizza/mc-community@sha256:' + 'f'.repeat(64) }
    fs.writeFileSync(join(directory, 'docker.config'), JSON.stringify(config))
    const environment = { PATH: `${directory}:${process.env.PATH}`,
      COMPOSE_PROJECT_NAME: 'wrong', PHP_IMAGE: 'wrong', NGINX_IMAGE: 'wrong' }
    const run = (command, overrides = {}) => spawnSync('sh', [join(root, 'docker/release/release.sh'), command, directory,
      ...(command === 'check' ? [manifest, root, runtime] : [])], { encoding: 'utf8', env: { ...environment, ...overrides } })
    const original = fs.readFileSync(join(directory, 'state.json'), 'utf8')
    assert.equal(run('status').status, 0)
    assert.equal(fs.existsSync(calls), false)
    assert.equal(run('check').status, 0)
    assert.equal(run('check').status, 0)
    const args = fs.readFileSync(calls, 'utf8').trim().split('\n')
    assert.deepEqual(args.slice(0, 3), ['compose', '--project-name', 'existing-production-project'])
    assert.deepEqual(args.slice(-3), ['config', '--format', 'json'])
    // Custom infrastructure names do not require expanding the PHP/Nginx manifest
    // or relaxing the ban on bind mounts, including mounts on infrastructure.
    config.services.minio.volumes = [{ type: 'bind', source: '/private', target: '/data' }]
    fs.writeFileSync(join(directory, 'docker.config'), JSON.stringify(config))
    assert.equal(run('check').status, 1)
    delete config.services.minio.volumes
    fs.writeFileSync(join(directory, 'docker.config'), JSON.stringify(config))
    fs.writeFileSync(join(directory, 'docker.fail'), '')
    const failure = run('check')
    assert.equal(failure.status, 1)
    assert.equal((failure.stdout + failure.stderr).includes('public-canary'), false)
    fs.unlinkSync(join(directory, 'docker.fail'))
    fs.writeFileSync(join(directory, 'docker.config'), '{public-canary')
    const invalidOutput = run('check')
    assert.equal(invalidOutput.status, 1)
    assert.equal((invalidOutput.stdout + invalidOutput.stderr).includes('public-canary'), false)
    assert.equal(run('deploy').status, 1)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), original)
    assert.equal(fs.readdirSync(directory).some(name => name.startsWith('.state-')), false)
    fs.writeFileSync(join(directory, 'state.json'), '{public-canary')
    const corrupt = run('status')
    assert.equal(corrupt.status, 1)
    assert.equal((corrupt.stdout + corrupt.stderr).includes('public-canary'), false)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), '{public-canary')
  } finally { fs.rmSync(directory, { recursive: true }) }
})

test('concurrent release command refuses the held directory lock without state changes', async () => {
  const directory = fixture()
  let holder
  try {
    writeFixture(directory, initialState('pizza-production'))
    const original = fs.readFileSync(join(directory, 'state.json'), 'utf8')
    holder = spawn('sh', ['-c', 'exec 9<"$1"; flock -n -x 9 || exit 1; echo ready; read done', 'sh', directory], { stdio: ['pipe', 'pipe', 'pipe'] })
    await new Promise((resolve, reject) => {
      holder.stdout.once('data', resolve)
      holder.once('error', reject)
      holder.once('exit', code => reject(new Error(`Lock holder exited: ${code}`)))
    })
    const blocked = spawnSync('sh', [join(root, 'docker/release/release.sh'), 'status', directory], { encoding: 'utf8' })
    assert.equal(blocked.status, 1)
    assert.notEqual(execute(directory, 'persist(process.env.TEST_DIR,null,initialState("pizza-production"));').status, 0)
    assert.equal(fs.readFileSync(join(directory, 'state.json'), 'utf8'), original)
    const exited = new Promise(resolve => holder.once('exit', resolve))
    holder.stdin.end('done\n')
    await exited
    assert.equal(spawnSync('sh', [join(root, 'docker/release/release.sh'), 'status', directory]).status, 0)
  } finally {
    if (holder && holder.exitCode === null) holder.kill()
    fs.rmSync(directory, { recursive: true })
  }
})
