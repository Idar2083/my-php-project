import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { create } from './manifest.mjs'
import { advance, begin, initialState, identity } from './state.mjs'
import { createBackup, preflight, restoreTest, verifyBackup } from './backup.mjs'
import { digest, verifyFiles, verifyPreflight } from './backup-format.mjs'
import { FakeBackup, scopedBackupRun, stateEvidence } from './backup-test-support.mjs'
import { FakeCoordinator } from './coordinator-test-support.mjs'

test('backup fixture scopes created resources while preserving command options and failures', () => {
  const calls = [], driver = { run(args, options) { calls.push({ args, options });return 'created' } }
  const run = scopedBackupRun(driver, 'fixture-owner'), options = { discardOutput: true }
  for (const args of [['create', 'image'], ['run', '--rm', 'image'], ['volume', 'create', 'volume']]) {
    assert.equal(run(args, options), 'created')
    const call = calls.at(-1)
    assert.ok(call.args.includes('pizza.backup-test-scope=fixture-owner'))
    assert.deepEqual(call.args.filter((_, index) => !['--label', 'pizza.backup-test-scope=fixture-owner'].includes(call.args[index])), args)
    assert.equal(call.options, options)
  }
  run(['inspect', 'container'])
  assert.deepEqual(calls.at(-1).args, ['inspect', 'container'])
  assert.throws(() => scopedBackupRun({ run() { throw new Error('controlled') } }, 'fixture-owner')(['create', 'image']), /controlled/)
})

const manifest = create({ CI_COMMIT_SHA:'a'.repeat(40), CI_PIPELINE_ID:'123', PHP_IMAGE:'registry.example.test/p/php@sha256:'+'b'.repeat(64), NGINX_IMAGE:'registry.example.test/p/nginx@sha256:'+'c'.repeat(64) })
function state(phase = 'quiesced') {
  let s = begin(initialState('pizza-backup-test'), manifest)
  for (const p of ['images_ready','quiescing','quiesced']) { s=advance(s,manifest,p); if (p===phase) break }
  return s
}
test('synthetic coordinator keeps preflight stable across wall-clock corrections', t => fixture(root => {
  const now = Date.UTC(2026, 0, 1)
  t.mock.timers.enable({ apis: ['Date'], now })
  const path = join(root, 'fixture.json')
  fs.writeFileSync(path, JSON.stringify({ calls: [], writers: [] }))
  const driver = new FakeCoordinator(path), value = state('images_ready')
  const receipt = preflight(value, root, driver.backup)
  for (const adjusted of [now - 1, now + 900000]) {
    t.mock.timers.setTime(adjusted)
    assert.equal(verifyPreflight(receipt, value.project, identity(manifest), value.revision).checked_at, new Date(now).toISOString())
  }
}))

test('production preflight rejects future, expired and changed-TTL receipts', t => fixture(root => {
  const now = Date.UTC(2026, 0, 1)
  t.mock.timers.enable({ apis: ['Date'], now })
  const value = state('images_ready'), receipt = preflight(value, root, new FakeBackup())
  const verify = () => verifyPreflight(receipt, value.project, identity(manifest), value.revision)
  assert.doesNotThrow(verify)
  t.mock.timers.setTime(now - 1)
  assert.throws(verify, /INVALID_BACKUP/)
  t.mock.timers.setTime(now + 900000)
  assert.throws(verify, /INVALID_BACKUP/)
  t.mock.timers.setTime(now)
  const changed = JSON.parse(fs.readFileSync(receipt, 'utf8'))
  changed.expires_at = new Date(now + 899999).toISOString()
  fs.writeFileSync(receipt, JSON.stringify(changed))
  assert.throws(verify, /INVALID_BACKUP/)
}))

test('synthetic state evidence keeps preflight stable across wall-clock corrections', t => fixture(root => {
  const now = Date.UTC(2026, 0, 1)
  t.mock.timers.enable({ apis: ['Date'], now })
  const value = state('images_ready')
  const receipt = stateEvidence(root, value, advance(value, manifest, 'quiescing')).preflight
  for (const adjusted of [now - 1, now + 900000]) {
    t.mock.timers.setTime(adjusted)
    assert.doesNotThrow(() => verifyPreflight(receipt, value.project, identity(manifest), value.revision))
  }
}))
function fixture(run) {
  const root=fs.mkdtempSync(join(tmpdir(),'pizza-backup-unit-'))
  try { return run(root) } finally { fs.rmSync(root,{recursive:true}) }
}

test('backup creates complete private artifacts, verifies and calls isolated restore',()=>fixture(root=>{
  const driver=new FakeBackup(), s=state()
  const backup=createBackup(s,root,'one',driver)
  const metadata=verifyBackup(backup,driver)
  assert.equal(metadata.release_id,identity(manifest))
  assert.equal(fs.statSync(join(backup,'postgres.dump')).mode&0o777,0o600)
  restoreTest(backup,driver)
  assert.ok(driver.calls.includes('restore-isolated'))
  assert.throws(()=>createBackup(s,root,'one',driver))
}))
for (const failure of ['dump','toc','snapshot']) test(`${failure} failure leaves no completed or partial backup`,()=>fixture(root=>{
  const driver=new FakeBackup()
  driver[failure]=()=>{throw new Error('SECRET_CANARY')}
  assert.throws(()=>createBackup(state(),root,'failure',driver))
  assert.deepEqual(fs.readdirSync(root),['.claim-failure'])
  assert.throws(()=>verifyFiles(join(root,'failure')))
}))
test('disk shortage and unsafe writers fail before dump or source modification',()=>fixture(root=>{
  const driver=new FakeBackup()
  assert.throws(()=>createBackup(state(),root,'space',driver,()=>({bavail:0n,bsize:4096n})),/INSUFFICIENT/)
  assert.equal(driver.calls.includes('dump'),false)
  driver.inventory=()=>{throw new Error('unsafe')}
  assert.throws(()=>createBackup(state(),root,'writers',driver))
  assert.deepEqual(fs.readdirSync(root),[])
}))
test('hash corruption, missing mandatory files, symlinks, invalid metadata and completion markers fail closed',()=>fixture(root=>{
  for (const problem of ['corrupt','missing','metadata','extra','link','complete']) {
    const backup=createBackup(state(),root,problem,new FakeBackup())
    if(problem==='corrupt') fs.appendFileSync(join(backup,'postgres.dump'),'changed')
    if(problem==='missing') fs.unlinkSync(join(backup,'globals.sql'))
    if(problem==='metadata') fs.writeFileSync(join(backup,'metadata.json'),'{broken')
    if(problem==='extra') fs.writeFileSync(join(backup,'unexpected'),'test')
    if(problem==='link') {fs.unlinkSync(join(backup,'minio.zip'));fs.symlinkSync('/dev/null',join(backup,'minio.zip'))}
    if(problem==='complete') fs.unlinkSync(join(backup,'COMPLETE'))
    const driver=new FakeBackup()
    assert.throws(()=>restoreTest(backup,driver))
    assert.equal(driver.calls.includes('restore-isolated'),false)
  }
}))
test('preflight is phase-bound and immutable; late writer restart aborts publication',()=>fixture(root=>{
  const driver=new FakeBackup()
  const path=preflight(state('images_ready'),root,driver)
  assert.equal(JSON.parse(fs.readFileSync(path)).state_revision,state('images_ready').revision)
  assert.throws(()=>preflight(state(),root,driver))
  let n=0; driver.inventory=()=>[String(n++)]
  assert.throws(()=>createBackup(state(),root,'changed',driver),/WRITER_STATE_CHANGED/)
  assert.equal(fs.existsSync(join(root,'changed')),false)
}))
test('SIGKILL before publication leaves only hidden uncommitted files and cannot reuse ID',()=>fixture(root=>{
  const module=new URL('./backup.mjs',import.meta.url).href, fake=new URL('./backup-test-support.mjs',import.meta.url).href
  const code=`import {createBackup} from ${JSON.stringify(module)};import {FakeBackup} from ${JSON.stringify(fake)};createBackup(${JSON.stringify(state())},${JSON.stringify(root)},'killed',new FakeBackup(),undefined,()=>process.kill(process.pid,'SIGKILL'));`
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH}})
  assert.equal(result.signal,'SIGKILL')
  assert.equal(fs.existsSync(join(root,'killed')),false)
  for(const item of fs.readdirSync(root).filter(name=>name.startsWith('.partial-'))) assert.throws(()=>verifyFiles(join(root,item)))
  assert.throws(()=>createBackup(state(),root,'killed',new FakeBackup()))
}))
test('CLI errors reveal neither config contents nor child command errors',()=>fixture(root=>{
  const stateFile=join(root,'state.json');fs.writeFileSync(stateFile,JSON.stringify(state()))
  const settings=join(root,'settings.json');fs.writeFileSync(settings,'{"secret":"SECRET_CANARY"}')
  const result=spawnSync('sh',[fileURLToPath(new URL('./backup.sh',import.meta.url)),'create',root,settings,root,'one'],{encoding:'utf8',env:{PATH:process.env.PATH}})
  assert.equal(result.status,1)
  assert.doesNotMatch(result.stdout+result.stderr,/SECRET_CANARY/)
}))
test('state persistence refuses quiescing, backup_ready and migrating without matching evidence',()=>fixture(root=>{
  const stateModule=new URL('./state.mjs',import.meta.url).href
  for(const [phase,next] of [['images_ready','quiescing'],['quiesced','backup_ready'],['backup_ready','migrating']]) {
    let s=state(phase==='backup_ready'?'quiesced':phase)
    if(phase==='backup_ready')s=advance(s,manifest,'backup_ready')
    const file=join(root,'state.json');fs.writeFileSync(file,JSON.stringify(s))
    const code=`import {readState,advance,persist} from ${JSON.stringify(stateModule)};const s=readState(process.env.TEST_ROOT);try{persist(process.env.TEST_ROOT,s,advance(s,s.operation.manifest,${JSON.stringify(next)}));process.exit(99)}catch{process.exit(42)}`
    const result=spawnSync('sh',['-c','exec 9<"$TEST_ROOT"; exec node --input-type=module -e "$TEST_CODE"'],{env:{PATH:process.env.PATH,TEST_ROOT:root,TEST_CODE:code}})
    assert.equal(result.status,42)
    assert.deepEqual(JSON.parse(fs.readFileSync(file)),s)
  }
}))

test('SIGKILL after COMPLETE but before publication cannot masquerade as a valid backup',()=>fixture(root=>{
  const module=new URL('./backup.mjs',import.meta.url).href, fake=new URL('./backup-test-support.mjs',import.meta.url).href
  const code=`import {createBackup} from ${JSON.stringify(module)};import {FakeBackup} from ${JSON.stringify(fake)};createBackup(${JSON.stringify(state())},${JSON.stringify(root)},'latekill',new FakeBackup(),undefined,(point)=>{if(point==='before-publication')process.kill(process.pid,'SIGKILL')});`
  const result=spawnSync(process.execPath,['--input-type=module','-e',code],{env:{PATH:process.env.PATH}})
  assert.equal(result.signal,'SIGKILL')
  assert.equal(fs.existsSync(join(root,'latekill')),false)
  const path=join(root,fs.readdirSync(root).find(name=>name.startsWith('.partial-')))
  assert.ok(fs.existsSync(join(path,'COMPLETE')))
  assert.throws(()=>verifyFiles(path),/UNPUBLISHED/)
}))
test('metadata allowlist, types and path fields are validated even when marker matches',()=>fixture(root=>{
  const backup=createBackup(state(),root,'schema',new FakeBackup())
  const original=JSON.parse(fs.readFileSync(join(backup,'metadata.json')))
  for(const change of [{secret:'CANARY'},{files:[]},{git_sha:'wrong'},{backup_id:['schema']},{created_at:'yesterday'},{postgres:{...original.postgres,format:'plain'}}]) {
    const metadata={...original,...change}
    fs.writeFileSync(join(backup,'metadata.json'),JSON.stringify(metadata))
    fs.writeFileSync(join(backup,'COMPLETE'),digest(join(backup,'metadata.json'))+'\n')
    assert.throws(()=>verifyFiles(backup))
  }
}))

test('child stderr with secrets is suppressed by the actual Docker adapter',()=>fixture(root=>{
  const bin=join(root,'bin');fs.mkdirSync(bin)
  fs.writeFileSync(join(bin,'docker'),'#!/bin/sh\nprintf SECRET_CANARY >&2\nexit 19\n',{mode:0o700})
  fs.writeFileSync(join(root,'state.json'),JSON.stringify(state()))
  const settings=join(root,'settings.json')
  fs.writeFileSync(settings,JSON.stringify({schema_version:1,project:'pizza-backup-test',postgres_container:'a'.repeat(64),minio_container:'b'.repeat(64),utility_image:'sha256:'+'c'.repeat(64),reserve_bytes:67108864}))
  const result=spawnSync('sh',[fileURLToPath(new URL('./backup.sh',import.meta.url)),'create',root,settings,root,'one'],{encoding:'utf8',env:{PATH:bin+':'+process.env.PATH}})
  assert.equal(result.status,1)
  assert.doesNotMatch(result.stdout+result.stderr,/SECRET_CANARY/)
  assert.equal(fs.existsSync(join(root,'one')),false)
}))
