import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { diagnoseKey } from './ssh-key-diagnostics.mjs'

const script = fileURLToPath(new URL('./ssh-key-diagnostics.mjs', import.meta.url))
const hash = bytes => createHash('sha256').update(bytes).digest('hex')
function fixture(run, passphrase = '') {
  const directory = fs.mkdtempSync(join(os.tmpdir(), 'pizza-key-diagnostics-test-'))
  const key = join(directory, 'PRIVATE_PATH_CANARY')
  try {
    const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', passphrase, '-C', 'KEY_COMMENT_CANARY', '-f', key], { stdio: 'ignore' })
    assert.equal(generated.status, 0, 'Synthetic key generation failed')
    const original = fs.readFileSync(key)
    return run({ directory, key, original, options: { temporaryRoot: directory } })
  } finally { fs.rmSync(directory, { recursive: true, force: true }) }
}
function assertClean(directory) {
  assert.equal(fs.readdirSync(directory).some(name => name.startsWith('pizza-key-diagnostics-')), false)
}
function assertSafe(report, original) {
  const output = JSON.stringify(report)
  assert.doesNotMatch(output, /PRIVATE_PATH_CANARY|KEY_COMMENT_CANARY|BEGIN OPENSSH|END OPENSSH|SECRET_ERROR_CANARY/)
  assert.equal(output.includes(original.toString('base64')), false)
  assert.equal(output.includes(original.toString('utf8')), false)
}

test('valid LF key reports source and byte-identical private copy, discarding ssh-keygen stdout', () => fixture(({ directory, key, original, options }) => {
  const calls = []
  const report = diagnoseKey(key, { ...options, execute(command, args, settings) {
    calls.push(args.at(-1))
    assert.equal(command, 'ssh-keygen')
    assert.deepEqual(args.slice(0, -1), ['-y', '-P', '', '-f'])
    assert.deepEqual(settings.stdio, ['ignore', 'ignore', 'pipe'])
    assert.equal(settings.timeout, 30000)
    assert.equal(hash(fs.readFileSync(args.at(-1))), hash(original))
    if (args.at(-1) !== key) {
      assert.equal(fs.statSync(args.at(-1)).mode & 0o777, 0o600)
      assert.equal(fs.statSync(join(args.at(-1), '..')).mode & 0o777, 0o700)
    }
    return spawnSync(command, args, settings)
  } })
  assert.equal(calls.length, 2)
  assert.equal(calls[0], key)
  assert.notEqual(calls[1], key)
  assert.equal(report.status, 'ok')
  assert.equal(report.cleanup, 'removed')
  assert.deepEqual(report.source, report.copy)
  assert.equal(report.source.type, 'regular_file')
  assert.equal(report.source.exists, true)
  assert.equal(report.source.size_bytes, original.length)
  assert.equal(report.source.sha256, hash(original))
  assert.equal(report.source.lf_count, original.filter(byte => byte === 10).length)
  assert.equal(report.source.crlf_count, 0)
  for (const name of ['header_ok', 'footer_ok', 'trailing_lf']) assert.equal(report.source[name], true)
  assert.equal(report.source.ssh_keygen, 'ok')
  assertSafe(report, original)
  assertClean(directory)
}))

test('source permissions rejected by OpenSSH do not fail a byte-identical 0600 copy', () => fixture(({ directory, key, original, options }) => {
  fs.chmodSync(key, 0o644)
  const report = diagnoseKey(key, options)
  assert.equal(fs.statSync(key).mode & 0o777, 0o644)
  assert.equal(report.source.status, 'ok')
  assert.equal(report.source.ssh_keygen, 'failed')
  assert.equal(report.copy.ssh_keygen, 'ok')
  assert.equal(report.source.sha256, hash(original))
  assert.equal(report.copy.sha256, report.source.sha256)
  assert.equal(report.status, 'ok')
  assert.equal(report.cleanup, 'removed')
  assertSafe(report, original)
  assertClean(directory)
}))

test('a parseable copy with a different hash still fails diagnostics', () => fixture(({ directory, key, original, options }) => {
  const report = diagnoseKey(key, { ...options, filesystem: { ...fs, writeFileSync(path, bytes, settings) {
    fs.writeFileSync(path, Buffer.concat([bytes, Buffer.from('\n')]), settings)
  } } })
  assert.equal(report.source.ssh_keygen, 'ok')
  assert.equal(report.copy.ssh_keygen, 'ok')
  assert.notEqual(report.source.sha256, report.copy.sha256)
  assert.equal(report.status, 'failed')
  assert.equal(report.cleanup, 'removed')
  assertSafe(report, original)
  assertClean(directory)
}))

for (const [name, transform, header, footer, trailing] of [
  ['missing final LF', bytes => bytes.subarray(0, -1), true, false, false],
  ['CRLF', bytes => Buffer.from(bytes.toString().replaceAll('\n', '\r\n')), false, false, true],
  ['BOM', bytes => Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]), false, true, true],
  ['truncated key', bytes => bytes.subarray(0, 100), true, false, false],
  ['empty file', () => Buffer.alloc(0), false, false, false],
  ['literal backslash n', bytes => Buffer.from(bytes.toString().replaceAll('\n', '\\n')), false, false, false],
]) {
  test(name + ' is measured without normalization and copy is cleaned after parser failure', () => fixture(({ directory, key, original, options }) => {
    const changed = transform(original)
    fs.writeFileSync(key, changed)
    const report = diagnoseKey(key, options)
    assert.equal(report.status, 'failed')
    assert.equal(report.cleanup, 'removed')
    assert.deepEqual(report.source, report.copy)
    assert.equal(report.source.sha256, hash(changed))
    assert.equal(report.source.size_bytes, changed.length)
    assert.equal(report.source.header_ok, header)
    assert.equal(report.source.footer_ok, footer)
    assert.equal(report.source.trailing_lf, trailing)
    assert.equal(report.source.lf_count, changed.filter(byte => byte === 10).length)
    assert.equal(report.source.crlf_count, name === 'CRLF' ? report.source.lf_count : 0)
    assert.ok(['invalid_format', 'libcrypto_error', 'failed'].includes(report.source.ssh_keygen))
    assertSafe(report, original)
    assertClean(directory)
  }))
}

test('passphrase-protected key is checked noninteractively with an empty passphrase', () => fixture(({ directory, key, original, options }) => {
  const report = diagnoseKey(key, options)
  assert.equal(report.status, 'failed')
  assert.equal(report.source.ssh_keygen, 'passphrase_error')
  assert.equal(report.copy.ssh_keygen, 'passphrase_error')
  assert.equal(report.cleanup, 'removed')
  assertSafe(report, original)
  assertClean(directory)
}, 'SYNTHETIC_PASSPHRASE'))

test('missing path, missing file, directories and symlinks do not invoke ssh-keygen or create copies', () => fixture(({ directory, key, options }) => {
  const noProcess = () => { assert.fail('Unexpected subprocess') }
  for (const path of [undefined, '', join(directory, 'missing'), directory]) {
    const report = diagnoseKey(path, { ...options, execute: noProcess })
    assert.equal(report.status, 'failed')
    assert.equal(report.cleanup, 'not_needed')
    assert.equal(report.copy.status, 'skipped')
    assert.equal(report.source.status, !path ? 'missing_path' : path === directory ? 'not_regular_file' : 'missing_file')
    assert.equal(report.source.exists, !path ? null : path === directory)
  }
  const link = join(directory, 'link')
  fs.symlinkSync(key, link)
  assert.equal(diagnoseKey(link, { ...options, execute: noProcess }).source.type, 'symlink')
  assertClean(directory)
}))

test('CLI with missing ssh-keygen reports only fixed statuses and cleans its copy', () => fixture(({ directory, key, original }) => {
  const result = spawnSync(process.execPath, [script], {
    encoding: 'utf8', env: { PATH: '', SSH_PRIVATE_KEY: key, TMPDIR: directory },
  })
  assert.equal(result.status, 1)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.source.ssh_keygen, 'not_found')
  assert.equal(report.copy.ssh_keygen, 'not_found')
  assert.equal(report.cleanup, 'removed')
  assertSafe(report, original)
  assertClean(directory)
}))

test('CLI success, missing variable and extra arguments never expose paths or child output', () => fixture(({ directory, key, original }) => {
  for (const [args, path, status] of [[[], key, 'ok'], [[], '', 'failed'], [['SECRET_ERROR_CANARY'], key, 'invalid_arguments']]) {
    const result = spawnSync(process.execPath, [script, ...args], {
      encoding: 'utf8', env: { PATH: process.env.PATH, SSH_PRIVATE_KEY: path, TMPDIR: directory },
    })
    assert.equal(result.stderr, '')
    assert.equal(result.status, status === 'ok' ? 0 : 1)
    const report = JSON.parse(result.stdout)
    assert.equal(report.status, status)
    assertSafe(report, original)
    assertClean(directory)
  }
}))

test('arbitrary child stderr, stdout and thrown exceptions become fixed statuses with cleanup', () => fixture(({ directory, key, original, options }) => {
  for (const execute of [
    () => ({ status: 1, stdout: original, stderr: 'SECRET_ERROR_CANARY' }),
    () => { throw new Error('SECRET_ERROR_CANARY') },
    () => ({ error: { code: 'ETIMEDOUT', message: 'SECRET_ERROR_CANARY' } }),
    () => ({ status: null, signal: 'SIGTERM', stderr: 'SECRET_ERROR_CANARY' }),
  ]) {
    const report = diagnoseKey(key, { ...options, execute })
    assert.ok(['failed', 'spawn_failed', 'timeout', 'terminated'].includes(report.source.ssh_keygen))
    assert.equal(report.status, 'failed')
    assert.equal(report.cleanup, 'removed')
    assertSafe(report, original)
    assertClean(directory)
  }
}))

test('copy failure removes a partially written key and inspection errors never print exceptions', () => fixture(({ directory, key, original, options }) => {
  const filesystem = { ...fs, writeFileSync(path, bytes, settings) {
    fs.writeFileSync(path, bytes, settings)
    throw new Error('SECRET_ERROR_CANARY')
  } }
  const report = diagnoseKey(key, { ...options, filesystem })
  assert.equal(report.copy.status, 'copy_failed')
  assert.equal(report.cleanup, 'removed')
  assertSafe(report, original)
  assertClean(directory)
  const denied = diagnoseKey(key, { ...options, filesystem: { ...fs, readFileSync() { throw new Error('SECRET_ERROR_CANARY') } } })
  assert.equal(denied.source.status, 'inspection_failed')
  assertSafe(denied, original)
}))

test('cleanup failure is explicit and fails the report instead of claiming removal', () => fixture(({ key, original, options }) => {
  const report = diagnoseKey(key, { ...options, filesystem: { ...fs, rmSync() { throw new Error('SECRET_ERROR_CANARY') } } })
  assert.equal(report.status, 'failed')
  assert.equal(report.cleanup, 'failed')
  assertSafe(report, original)
}))

test('CI diagnostics are optional manual branch jobs with no artifacts or deployment commands', () => {
  const yaml = fs.readFileSync(new URL('../../.gitlab-ci.yml', import.meta.url), 'utf8')
  assert.match(yaml.split(/^release-checks:\r?$/m)[1]?.split(/^(?=\S)/m)[0] || '', /docker\/release\/ssh-key-diagnostics\.test\.mjs/)
  const job = yaml.split(/^diagnose-ssh-key:\r?$/m)[1]?.split(/^(?=\S)/m)[0]
  assert.ok(job)
  assert.match(job, /stage: code-quality/)
  assert.match(job, /image: node:24-alpine/)
  assert.match(job, /needs: \[\]/)
  assert.match(job, /allow_failure: true/)
  assert.match(job, /when: manual/)
  assert.match(job, /when: never/)
  assert.match(job, /apk add --no-cache openssh-client/)
  assert.equal(job.split(/  script:\r?\n/)[1].trim(), '- node docker/release/ssh-key-diagnostics.mjs')
  assert.doesNotMatch(job, /dependencies:|artifacts:|trigger:|extends:|environment:|variables:|deploy-ssh|deploy-production|docker push|ssh /)
  assert.equal(job.match(/- if: '([^']+)'/)[1], '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH')
  const available = env => env.CI_PIPELINE_SOURCE === 'push' && Boolean(env.CI_COMMIT_BRANCH)
  for (const branch of ['main', 'feature/task-12-frontend']) {
    for (const protectedRef of ['true', 'false']) {
      assert.equal(available({ CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: branch, CI_COMMIT_REF_PROTECTED: protectedRef }), true)
    }
  }
  for (const context of [
    { CI_PIPELINE_SOURCE: 'push', CI_COMMIT_TAG: 'v1.0.1' },
    { CI_PIPELINE_SOURCE: 'merge_request_event', CI_COMMIT_BRANCH: 'feature/example' },
    { CI_PIPELINE_SOURCE: 'web', CI_COMMIT_BRANCH: 'main' },
    { CI_PIPELINE_SOURCE: 'schedule', CI_COMMIT_BRANCH: 'main' },
  ]) assert.equal(available(context), false)
})
