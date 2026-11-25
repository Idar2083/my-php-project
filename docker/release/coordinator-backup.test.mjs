import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { create } from './manifest.mjs'
import { initialState } from './state.mjs'
import { digest, verifyFiles } from './backup-format.mjs'
import { writerOrder } from './coordinator-docker.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const coordinator = new URL('./coordinator.mjs', import.meta.url).href
const fake = new URL('./coordinator-test-support.mjs', import.meta.url).href
const manifest = create({ CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123',
  PHP_IMAGE: 'registry.example.test/pizza/php@sha256:' + 'b'.repeat(64), NGINX_IMAGE: 'registry.example.test/pizza/nginx@sha256:' + 'c'.repeat(64) })
const baseline = { ...initialState('pizza-backup-test'), revision: 10, current: { ...manifest, pipeline_id: '122' } }

async function fixture(run) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-coordinator-backup-'))
  try {
    fs.mkdirSync(join(directory, 'backup'), { mode: 0o700 })
    fs.writeFileSync(join(directory, 'state.json'), JSON.stringify(baseline), { mode: 0o600 })
    fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ calls: [], stops: [], writers: writerOrder.map((service, index) => ({
      id: String(index + 1).repeat(64), service, image: 'sha256:' + 'e'.repeat(64), started_at: '2026-10-16T01:00:00Z', running: true, exit_code: 0, oom: false,
    })) }))
    await run(directory)
  } finally { fs.rmSync(directory, { recursive: true }) }
}
function read(directory, file = 'fixture.json') { return JSON.parse(fs.readFileSync(join(directory, file), 'utf8')) }
function change(directory, value) { fs.writeFileSync(join(directory, 'fixture.json'), JSON.stringify({ ...read(directory), ...value })) }
function stateBytes(directory) { return fs.readFileSync(join(directory, 'state.json'), 'utf8') }
function copies(directory) { return fs.readdirSync(join(directory, 'backup')).filter(name => /^[a-f0-9]{64}$/.test(name)) }
function claims(directory) { return fs.readdirSync(join(directory, 'backup')).filter(name => name.startsWith('.claim-')) }
function options(directory, code = '') {
  return { encoding: 'utf8', env: { PATH: process.env.PATH, TEST_DIRECTORY: directory, TEST_CODE: `
    import fs from 'node:fs';
    import {fixtureFailure} from ${JSON.stringify(new URL('./release-test-diagnostics.mjs', import.meta.url).href)};
    import {backupRelease,prepareBackup} from ${JSON.stringify(coordinator)};
    import {FakeCoordinator} from ${JSON.stringify(fake)};
    const directory=process.env.TEST_DIRECTORY;
    const driver=new FakeCoordinator(directory+'/fixture.json');
    const manifest=${JSON.stringify(manifest)};
    ${code}
    try {
      const result=backupRelease(directory,manifest,'unused-bundle','unused-runtime',directory+'/backup',driver);
      fs.writeFileSync(directory+'/result.json',JSON.stringify(result));
    } catch(error) {process.stderr.write(fixtureFailure(error, 'backupRelease'));process.exitCode=1}
  ` } }
}
const shell = ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;exec node --input-type=module -e "$TEST_CODE"']
function execute(directory, code = '') { return spawnSync('sh', shell, options(directory, code)) }

function rewriteMetadata(path, update) {
  const metadata = JSON.parse(fs.readFileSync(join(path, 'metadata.json'), 'utf8'))
  update(metadata)
  fs.writeFileSync(join(path, 'metadata.json'), JSON.stringify(metadata))
  fs.writeFileSync(join(path, 'COMPLETE'), digest(join(path, 'metadata.json')) + '\n')
}

test('one locked operation prepares, creates, restores and records backup_ready without starting writers', () => fixture(directory => {
  const result = execute(directory)
  assert.equal(result.status, 0, result.stderr)
  const state = read(directory, 'state.json'), data = read(directory)
  assert.equal(state.operation.phase, 'backup_ready')
  assert.equal(state.revision, baseline.revision + 5)
  assert.deepEqual(state.current, baseline.current)
  assert.equal(state.previous, baseline.previous)
  assert.deepEqual(data.stops, writerOrder)
  assert.equal(data.writers.every(item => !item.running), true)
  const output = read(directory, 'result.json')
  assert.equal(output.backupPath, join(directory, 'backup', copies(directory)[0]))
  const metadata = verifyFiles(output.backupPath)
  assert.equal(metadata.state_revision, state.revision - 1)
  assert.ok(data.calls.indexOf('dump') > data.calls.indexOf('stop:minio'))
  assert.ok(data.calls.indexOf('restore') > data.calls.indexOf('archive'))
  assert.equal(data.calls.filter(call => call === 'dump').length, 1)
}))

test('backup_ready retry revalidates/restores the same copy, needs no new-copy space and preserves state bytes', () => fixture(directory => {
  assert.equal(execute(directory).status, 0)
  const state = stateBytes(directory), copy = copies(directory)
  const metadata = fs.readFileSync(join(directory, 'backup', copy[0], 'metadata.json'), 'utf8')
  change(directory, { calls: [], space_failure: true })
  assert.equal(execute(directory).status, 0)
  assert.equal(stateBytes(directory), state)
  assert.deepEqual(copies(directory), copy)
  assert.equal(fs.readFileSync(join(directory, 'backup', copy[0], 'metadata.json'), 'utf8'), metadata)
  assert.equal(read(directory).calls.includes('restore'), true)
  assert.equal(read(directory).calls.some(call => ['dump', 'archive', 'estimate'].includes(call) || call.startsWith('pull:') || call.startsWith('stop:')), false)
}))

for (const failure of ['dump', 'archive', 'version', 'toc']) {
  test(`${failure} failure keeps writers stopped and retry uses a new reserved ID`, () => fixture(directory => {
    change(directory, { fail: failure })
    assert.equal(execute(directory).status, 1)
    assert.equal(read(directory, 'state.json').operation.phase, 'quiesced')
    assert.equal(read(directory).writers.every(writer => !writer.running), true)
    assert.equal(copies(directory).length, 0)
    const oldClaim = claims(directory)
    assert.equal(oldClaim.length, 1)
    change(directory, { fail: null })
    assert.equal(execute(directory).status, 0)
    assert.equal(claims(directory).length, 2)
    assert.notEqual(copies(directory)[0], oldClaim[0].slice('.claim-'.length))
    assert.deepEqual(read(directory).stops, writerOrder)
  }))
}

for (const failure of ['restore', 'state-write', 'post-restore-toc']) {
  test(`${failure} after publication keeps quiesced; retry reuses and verifies the published copy`, () => fixture(directory => {
    const code = failure === 'state-write'
      ? `const rename=fs.renameSync;fs.renameSync=(src,dst)=>{if(dst===directory+'/state.json'&&JSON.parse(fs.readFileSync(src)).operation.phase==='backup_ready')throw new Error('controlled');return rename(src,dst)};`
      : failure === 'post-restore-toc'
        ? `const restore=driver.backup.restore;driver.backup.restore=(...args)=>{restore(...args);const value=driver.read();value.fail='toc';driver.write(value)};` : ''
    if (failure === 'restore') change(directory, { fail: 'restore' })
    const result = execute(directory, code)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(read(directory, 'state.json').operation.phase, 'quiesced', result.stderr)
    assert.equal(copies(directory).length, 1)
    const copy = copies(directory)
    change(directory, { fail: null, calls: [], space_failure: true })
    assert.equal(execute(directory).status, 0)
    assert.deepEqual(copies(directory), copy)
    assert.equal(read(directory).calls.includes('dump'), false)
    assert.equal(read(directory).calls.includes('restore'), true)
  }))
}

for (const point of ['dump', 'before-publication', 'after-publication', 'restore', 'after-state-publication']) {
  test(`SIGKILL at ${point} resumes safely without overwriting any attempt`, () => fixture(directory => {
    let code
    if (point === 'dump' || point === 'restore') {
      code = `const action=driver.backup.${point};driver.backup.${point}=(...args)=>{action(...args);process.kill(process.pid,'SIGKILL')};`
    } else {
      const backupRename = `dst.startsWith(directory+'/backup/') && /^[a-f0-9]{64}$/.test(dst.split('/').at(-1))`
      code = `const rename=fs.renameSync;fs.renameSync=(src,dst)=>{
        const selected=${point === 'after-state-publication' ? `dst===directory+'/state.json'&&JSON.parse(fs.readFileSync(src)).operation.phase==='backup_ready'` : backupRename};
        if(selected&&${JSON.stringify(point)}==='before-publication')process.kill(process.pid,'SIGKILL');
        const result=rename(src,dst);if(selected)process.kill(process.pid,'SIGKILL');return result;
      };`
    }
    assert.notEqual(execute(directory, code).status, 0)
    const interrupted = stateBytes(directory), oldCopies = copies(directory), oldClaims = claims(directory)
    assert.equal(read(directory).writers.every(writer => !writer.running), true)
    assert.equal(execute(directory).status, 0)
    assert.equal(read(directory, 'state.json').operation.phase, 'backup_ready')
    assert.deepEqual(read(directory).stops, writerOrder)
    if (['dump', 'before-publication'].includes(point)) {
      assert.equal(oldCopies.length, 0)
      assert.equal(claims(directory).length, oldClaims.length + 1)
      assert.notEqual(copies(directory)[0], oldClaims[0].slice('.claim-'.length))
      assert.ok(fs.readdirSync(join(directory, 'backup')).some(name => name.startsWith('.partial-')))
    } else assert.deepEqual(copies(directory), oldCopies)
    if (point === 'after-state-publication') assert.equal(stateBytes(directory), interrupted)
  }))
}

for (const phase of ['quiesced', 'backup_ready']) {
  for (const problem of ['corrupt', 'missing', 'foreign-project', 'wrong-operation', 'wrong-revision', 'symlink']) {
    test(`${problem} published backup in ${phase} ${problem === 'missing' && phase === 'quiesced' ? 'reserves a new ID' : 'fails closed without a replacement'}`, () => fixture(directory => {
      change(directory, { fail: 'restore' })
      if (phase === 'backup_ready') change(directory, { fail: null })
      assert.equal(execute(directory).status, phase === 'backup_ready' ? 0 : 1)
      change(directory, { fail: null, calls: [] })
      const path = join(directory, 'backup', copies(directory)[0])
      if (problem === 'corrupt') fs.appendFileSync(join(path, 'postgres.dump'), 'corrupt')
      if (problem === 'missing') fs.rmSync(path, { recursive: true })
      if (problem === 'foreign-project') rewriteMetadata(path, value => { value.project = 'foreign' })
      if (problem === 'wrong-operation') rewriteMetadata(path, value => { value.operation_id = '0'.repeat(64) })
      if (problem === 'wrong-revision') rewriteMetadata(path, value => { value.state_revision++ })
      if (problem === 'symlink') {
        fs.renameSync(path, path + '-saved')
        fs.symlinkSync(path + '-saved', path)
      }
      const state = stateBytes(directory)
      // Before a successful acceptance, deletion of an already published copy is
      // indistinguishable from an incomplete attempt; its claim is never reused.
      const expected = problem === 'missing' && phase === 'quiesced' ? 0 : 1
      assert.equal(execute(directory).status, expected)
      if (expected) {
        assert.equal(stateBytes(directory), state)
        assert.equal(read(directory).calls.includes('dump'), false)
      }
      assert.equal(read(directory).writers.every(writer => !writer.running), true)
    }))
  }
}

test('writer restart during restore blocks backup_ready; changed plan/config also blocks retry', () => fixture(directory => {
  const result = execute(directory, `const restore=driver.backup.restore;driver.backup.restore=(...args)=>{restore(...args);const value=driver.read();value.writers[0].started_at='restarted';driver.write(value)};`)
  assert.equal(result.status, 1)
  assert.equal(read(directory, 'state.json').operation.phase, 'quiesced')
  change(directory, { calls: [] })
  assert.equal(execute(directory).status, 1)
  assert.equal(read(directory).calls.includes('restore'), false)
}))

test('missing lock and concurrent release/backup commands cannot create another copy', { timeout: 15000 }, async () => fixture(async directory => {
  const code = `const dump=driver.backup.dump;driver.backup.dump=(...args)=>{dump(...args);fs.writeSync(1,'locked\\n');fs.readSync(0,Buffer.alloc(1),0,1,null)};`
  const holder = spawn('sh', shell, { ...options(directory, code), stdio: ['pipe', 'pipe', 'pipe'] })
  try {
    await new Promise((resolve, reject) => { holder.stdout.once('data', resolve);holder.once('error', reject);holder.once('exit', () => reject(new Error('Holder exited before dump'))) })
    const before = stateBytes(directory), attempts = claims(directory)
    const args = ['backup', directory, 'unused', 'unused', 'unused', 'unused', join(directory, 'backup')]
    assert.equal(spawnSync('sh', [join(root, 'docker/release/release.sh'), ...args], { encoding: 'utf8' }).status, 1)
    assert.equal(spawnSync('sh', [join(root, 'docker/release/backup.sh'), 'verify', directory, 'unused', 'unused'], { encoding: 'utf8' }).status, 1)
    assert.equal(spawnSync(process.execPath, ['--input-type=module', '-e', options(directory).env.TEST_CODE], { env: options(directory).env, encoding: 'utf8' }).status, 1)
    assert.equal(stateBytes(directory), before)
    assert.deepEqual(claims(directory), attempts)
    const exited = new Promise(resolve => holder.once('exit', resolve));holder.stdin.end('x');assert.equal(await exited, 0)
  } finally {
    if (holder.exitCode === null) { holder.stdin.end('x');await new Promise(resolve => holder.once('exit', resolve)) }
  }
}))

for (const failure of ['tools', 'space']) {
  test(`${failure} failure after quiesce keeps writers stopped without claiming a backup ID`, () => fixture(directory => {
    const code = failure === 'tools'
      ? `const tools=driver.backup.preflightTools;driver.backup.preflightTools=()=>{if(driver.read().writers.every(item=>!item.running))throw new Error('controlled');tools()};`
      : `const estimate=driver.backup.estimate;driver.backup.estimate=()=>driver.read().writers.every(item=>!item.running)?2n**100n:estimate();`
    assert.equal(execute(directory, code).status, 1)
    assert.equal(read(directory, 'state.json').operation.phase, 'quiesced')
    assert.deepEqual(claims(directory), [])
    assert.equal(read(directory).writers.every(item => !item.running), true)
    assert.equal(execute(directory).status, 0)
  }))
}

test('invalid claim entries cannot redirect or overwrite a new attempt', () => fixture(directory => {
  change(directory, { fail: 'dump' })
  assert.equal(execute(directory).status, 1)
  const claim = join(directory, 'backup', claims(directory)[0])
  fs.rmdirSync(claim)
  fs.symlinkSync(join(directory, 'absent'), claim)
  change(directory, { fail: null, calls: [] })
  const before = stateBytes(directory)
  assert.equal(execute(directory).status, 1)
  assert.equal(stateBytes(directory), before)
  assert.equal(read(directory).calls.includes('dump'), false)
  assert.equal(fs.existsSync(join(directory, 'absent')), false)
}))

test('already current release is never stopped or backed up again', () => fixture(directory => {
  fs.writeFileSync(join(directory, 'state.json'), JSON.stringify({ ...baseline, current: manifest }))
  const before = stateBytes(directory)
  assert.equal(execute(directory).status, 0)
  assert.equal(stateBytes(directory), before)
  assert.equal(read(directory, 'result.json').backupPath, null)
  assert.deepEqual(read(directory).calls, ['check'])
  assert.deepEqual(claims(directory), [])
}))

for (const changeAt of ['after-verification', 'runtime-during-restore']) {
  test(`${changeAt} cannot become a new baseline for accepting the backup`, () => fixture(directory => {
    const code = changeAt === 'after-verification'
      ? `const toc=driver.backup.toc;let count=0;driver.backup.toc=(...args)=>{toc(...args);if(++count===2){const value=driver.read();value.writers[0].started_at='restarted';driver.write(value)}};`
      : `const restore=driver.backup.restore;driver.backup.restore=(...args)=>{restore(...args);const value=driver.read();value.configuration=2;driver.write(value)};`
    const result = execute(directory, code)
    assert.equal(result.status, 1, result.stderr)
    assert.equal(read(directory, 'state.json').operation.phase, 'quiesced', result.stderr)
    assert.equal(copies(directory).length, 1)
    assert.deepEqual(read(directory).stops, writerOrder)
  }))
}
