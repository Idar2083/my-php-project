import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { create } from './manifest.mjs'
import { advance, begin, initialState } from './state.mjs'
import { createBackup } from './backup.mjs'
import { digest } from './backup-format.mjs'
import { FakeBackup } from './backup-test-support.mjs'

const release = fileURLToPath(new URL('./release.sh', import.meta.url))
const first = create({ CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '101',
  PHP_IMAGE: 'registry.example.test/p/php@sha256:' + 'b'.repeat(64),
  NGINX_IMAGE: 'registry.example.test/p/nginx@sha256:' + 'c'.repeat(64) })
const target = create({ CI_COMMIT_SHA: 'd'.repeat(40), CI_PIPELINE_ID: '102', PHP_IMAGE: first.images.php, NGINX_IMAGE: first.images.nginx })
const phases = ['images_ready', 'quiescing', 'quiesced', 'backup_ready', 'migrating', 'migrated', 'starting', 'verified', 'committed']
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'"
function fixture(run) {
  const root = fs.mkdtempSync(join(tmpdir(), 'pizza-backup-state-'))
  try {
    let state = begin(initialState('pizza-backup-test'), first)
    for (const phase of phases) state = advance(state, first, phase)
    state = begin(state, target)
    for (const phase of phases.slice(0, 3)) state = advance(state, target, phase)
    const stateFile = join(root, 'state.json'), manifest = join(root, 'release.json'), config = join(root, 'config.json')
    fs.writeFileSync(stateFile, JSON.stringify(state))
    fs.writeFileSync(manifest, JSON.stringify(target))
    fs.writeFileSync(config, JSON.stringify({ schema_version: 1, project: state.project, postgres_container: 'a'.repeat(64),
      minio_container: 'b'.repeat(64), utility_image: 'sha256:' + 'c'.repeat(64), reserve_bytes: 67108864 }))
    const backup = createBackup(state, root, 'snapshot', new FakeBackup())
    const bin = join(root, 'bin'), calls = join(root, 'calls'), failure = join(root, 'fail-toc')
    fs.mkdirSync(bin)
    // Only the existing TOC verification is allowed. No daemon or services.
    fs.writeFileSync(join(bin, 'docker'), `#!/bin/sh
[ "$1" = run ] || exit 88
for last do :; done
[ "$last" = --list ] || exit 88
printf '%s\\n' "$*" >> ${shellQuote(calls)}
if [ -f ${shellQuote(failure)} ]; then printf SECRET_CANARY >&2; exit 9; fi
`, { mode: 0o700 })
    const execute = (command, candidate = manifest, path = backup) => spawnSync('sh', [release, command, root, candidate, config, path], {
      encoding: 'utf8', env: { PATH: `${bin}:${process.env.PATH}` },
    })
    const bytes = () => fs.readFileSync(stateFile, 'utf8')
    const stored = () => JSON.parse(bytes())
    const rewriteBackup = change => {
      const path = join(backup, 'metadata.json')
      fs.writeFileSync(path, JSON.stringify({ ...JSON.parse(fs.readFileSync(path)), ...change }))
      fs.writeFileSync(join(backup, 'COMPLETE'), digest(path) + '\n')
    }
    run({ root, state, stateFile, backup, manifest, calls, failure, execute, bytes, stored, rewriteBackup })
  } finally { fs.rmSync(root, { recursive: true }) }
}

test('release commands verify backup and persist only the two authorized phases', () => fixture(f => {
  assert.equal(f.execute('mark-migrating').status, 1, 'Cannot skip backup_ready')
  assert.equal(f.execute('accept-backup').status, 0)
  assert.equal(f.stored().operation.phase, 'backup_ready')
  assert.equal(f.stored().revision, f.state.revision + 1)
  assert.equal(f.execute('mark-migrating').status, 0)
  assert.equal(f.stored().operation.phase, 'migrating')
  assert.equal(f.stored().revision, f.state.revision + 2)
  assert.deepEqual(f.stored().current, f.state.current)
  assert.deepEqual(f.stored().previous, f.state.previous)
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 2)
}))

test('missing backup never changes release state', () => fixture(f => {
  const before = f.bytes()
  assert.equal(f.execute('accept-backup', f.manifest, join(f.root, 'missing')).status, 1)
  assert.equal(f.bytes(), before)
  assert.equal(fs.existsSync(f.calls), false)
}))

test('foreign target/source release and stale backup revision are rejected', () => fixture(f => {
  const before = f.bytes(), other = join(f.root, 'other.json')
  fs.writeFileSync(other, JSON.stringify(first))
  assert.equal(f.execute('accept-backup', other).status, 1)
  assert.equal(f.bytes(), before)
  const original = JSON.parse(fs.readFileSync(join(f.backup, 'metadata.json')))
  for (const change of [{ release_id: 'e'.repeat(64) }, { operation_id: 'f'.repeat(64) }, { state_revision: f.state.revision - 1 }]) {
    f.rewriteBackup({ ...original, ...change })
    assert.equal(f.execute('accept-backup').status, 1)
    assert.equal(f.bytes(), before)
  }
}))

test('repeat commands reverify but preserve state bytes and revision', () => fixture(f => {
  for (const command of ['accept-backup', 'mark-migrating']) {
    assert.equal(f.execute(command).status, 0)
    const before = f.bytes()
    assert.equal(f.execute(command).status, 0)
    assert.equal(f.bytes(), before)
  }
  assert.equal(fs.readFileSync(f.calls, 'utf8').trim().split('\n').length, 4)
  const before = f.bytes()
  assert.equal(f.execute('accept-backup').status, 1, 'Cannot go backwards from migrating')
  assert.equal(f.bytes(), before)
}))

test('TOC failure or corrupted backup blocks migrations and repeat acceptance without leaking stderr', () => fixture(f => {
  assert.equal(f.execute('accept-backup').status, 0)
  const before = f.bytes()
  fs.writeFileSync(f.failure, '')
  const failed = f.execute('mark-migrating')
  assert.equal(failed.status, 1)
  assert.doesNotMatch(failed.stdout + failed.stderr, /SECRET_CANARY/)
  assert.equal(f.bytes(), before)
  fs.unlinkSync(f.failure)
  fs.appendFileSync(join(f.backup, 'postgres.dump'), 'corrupt')
  for (const command of ['mark-migrating', 'accept-backup']) {
    assert.equal(f.execute(command).status, 1)
    assert.equal(f.bytes(), before)
  }
}))

for (const command of ['accept-backup', 'mark-migrating']) {
  test(`${command}: shell arguments fail closed before Docker or state writes`, () => fixture(f => {
    const valid = [command, f.root, f.manifest, join(f.root, 'config.json'), f.backup]
    const before = f.bytes()
    for (const args of [valid.slice(0, 2), valid.slice(0, -1), [...valid, 'unexpected']]) {
      const result = spawnSync('sh', [release, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.match(result.stderr, /^Release command failed:/)
      assert.equal(f.bytes(), before)
      assert.equal(fs.existsSync(f.calls), false)
    }
  }))
}
