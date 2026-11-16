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

function connectionFixture(run) {
  return fixture(context => {
    const hosts = join(context.directory, 'KNOWN_HOSTS_PATH_CANARY')
    fs.writeFileSync(hosts, 'vps.example.test ' + fs.readFileSync(context.key + '.pub', 'utf8'))
    const connection = { SSH_KNOWN_HOSTS: hosts, DEPLOY_HOST: 'vps.example.test', DEPLOY_PORT: '22', DEPLOY_USER: 'ci_probe' }
    return run({ ...context, hosts, connection, options: { ...context.options, connection } })
  })
}

test('SSH handshake uses byte-identical private copies, strict options and only id -un', () => connectionFixture(({ directory, key, hosts, original, options }) => {
  const knownHosts = fs.readFileSync(hosts)
  fs.chmodSync(key, 0o644)
  let called = false
  const report = diagnoseKey(key, { ...options, execute(command, args, settings) {
    if (command !== 'ssh') return spawnSync(command, args, settings)
    called = true
    const copiedKey = args[args.indexOf('-i') + 1]
    const copiedHosts = args.find(value => value.startsWith('UserKnownHostsFile=')).slice('UserKnownHostsFile='.length)
    assert.notEqual(copiedKey, key)
    assert.notEqual(copiedHosts, hosts)
    assert.deepEqual(fs.readFileSync(copiedKey), original)
    assert.deepEqual(fs.readFileSync(copiedHosts), knownHosts)
    for (const path of [copiedKey, copiedHosts]) assert.equal(fs.statSync(path).mode & 0o777, 0o600)
    assert.equal(fs.statSync(join(copiedKey, '..')).mode & 0o777, 0o700)
    assert.deepEqual(args, ['-F', '/dev/null', '-T', '-p', '22', '-i', copiedKey,
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UserKnownHostsFile=' + copiedHosts, '-o', 'ConnectTimeout=15',
      '-o', 'PasswordAuthentication=no', '-o', 'PreferredAuthentications=publickey',
      'ci_probe@vps.example.test', 'id -un'])
    assert.deepEqual(settings.stdio, ['ignore', 'pipe', 'pipe'])
    assert.equal(settings.timeout, 30000)
    assert.equal(settings.killSignal, 'SIGKILL')
    assert.equal(settings.shell, undefined)
    return { status: 0, stdout: 'ci_probe\n', stderr: 'SECRET_ERROR_CANARY' }
  } })
  assert.equal(called, true)
  assert.equal(report.status, 'ok')
  assert.equal(report.source.ssh_keygen, 'failed')
  assert.equal(report.copy.ssh_keygen, 'ok')
  assert.deepEqual(report.connection, { status: 'ok', stage: 'remote-user', reason: 'ok' })
  assert.equal(report.cleanup, 'removed')
  assert.deepEqual(fs.readFileSync(hosts), knownHosts)
  assertSafe(report, original)
  assertClean(directory)
}))

for (const [name, outcome, stage, reason] of [
  ['wrong user', { status: 0, stdout: 'SECRET_ERROR_CANARY\n' }, 'remote-user', 'unexpected_user'],
  ['authentication', { status: 255, stderr: 'Permission denied (publickey). SECRET_ERROR_CANARY' }, 'ssh-handshake', 'authentication_failed'],
  ['host mismatch', { status: 255, stderr: 'REMOTE HOST IDENTIFICATION HAS CHANGED! SECRET_ERROR_CANARY' }, 'ssh-handshake', 'host_key_error'],
  ['unknown host key', { status: 255, stderr: 'Host key verification failed. SECRET_ERROR_CANARY' }, 'ssh-handshake', 'host_key_error'],
  ['timeout', { error: { code: 'ETIMEDOUT', message: 'SECRET_ERROR_CANARY' }, signal: 'SIGKILL' }, 'ssh-handshake', 'timeout'],
  ['DNS', { status: 255, stderr: 'Could not resolve hostname SECRET_ERROR_CANARY' }, 'ssh-handshake', 'dns_error'],
  ['refused', { status: 255, stderr: 'Connection refused SECRET_ERROR_CANARY' }, 'ssh-handshake', 'connection_refused'],
  ['missing SSH', { error: { code: 'ENOENT' } }, 'ssh-handshake', 'not_found'],
  ['signal', { status: null, signal: 'SIGTERM' }, 'ssh-handshake', 'terminated'],
  ['arbitrary stderr', { status: 255, stderr: 'SECRET_ERROR_CANARY' }, 'ssh-handshake', 'failed'],
]) {
  test('SSH ' + name + ' is safely reported and temporary files are removed', () => connectionFixture(({ directory, key, original, options }) => {
    const report = diagnoseKey(key, { ...options, execute: (command, args, settings) => command === 'ssh' ? outcome : spawnSync(command, args, settings) })
    assert.equal(report.status, 'failed')
    assert.deepEqual(report.connection, { status: 'failed', stage, reason })
    assert.equal(report.cleanup, 'removed')
    assertSafe(report, original)
    assertClean(directory)
  }))
}

test('missing or unsafe connection variables prevent SSH without disclosing values', () => connectionFixture(({ directory, key, original, connection, options }) => {
  for (const patch of [
    ...Object.keys(connection).map(name => ({ [name]: '' })),
    { DEPLOY_HOST: '-oProxyCommand=SECRET_ERROR_CANARY' }, { DEPLOY_PORT: '0' }, { DEPLOY_PORT: '65536' },
    { DEPLOY_USER: 'root' }, { DEPLOY_USER: 'ci;SECRET_ERROR_CANARY' },
  ]) {
    const report = diagnoseKey(key, { ...options, connection: { ...connection, ...patch }, execute(command, args, settings) {
      assert.equal(command, 'ssh-keygen')
      assert.ok(args.includes('-y'))
      return spawnSync(command, args, settings)
    } })
    assert.deepEqual(report.connection, { status: 'failed', stage: 'ssh-configuration', reason: 'invalid_configuration' })
    assert.equal(report.status, 'failed')
    assert.equal(report.cleanup, 'removed')
    assertSafe(report, original)
    assertClean(directory)
  }
  const missingKey = diagnoseKey(undefined, options)
  assert.equal(missingKey.source.status, 'missing_path')
  assert.equal(missingKey.status, 'failed')
}))

test('known_hosts failures stop before SSH and clean copies', () => connectionFixture(({ directory, key, hosts, original, options }) => {
  for (const [content, stage, reason] of [
    ['malformed SECRET_ERROR_CANARY', 'known-hosts-format', 'invalid_format'],
    ['vps.example.test ssh-ed25519 AAAA\n', 'known-hosts-validation', 'failed'],
    ['other.example.test ' + fs.readFileSync(key + '.pub', 'utf8'), 'known-hosts-match', 'failed'],
  ]) {
    fs.writeFileSync(hosts, content)
    const report = diagnoseKey(key, { ...options, execute(command, args, settings) {
      assert.equal(command, 'ssh-keygen')
      return spawnSync(command, args, settings)
    } })
    assert.deepEqual(report.connection, { status: 'failed', stage, reason })
    assert.equal(report.status, 'failed')
    assert.equal(report.cleanup, 'removed')
    assertSafe(report, original)
    assertClean(directory)
  }
}))

test('copy and process exceptions are sanitized and cleanup remains mandatory for connectivity', () => connectionFixture(({ directory, key, hosts, original, options }) => {
  for (const target of ['key', 'known_hosts']) {
    const report = diagnoseKey(key, { ...options, filesystem: { ...fs, writeFileSync(path, bytes, settings) {
      fs.writeFileSync(path, bytes, settings)
      if (path.endsWith('/' + target)) throw new Error('SECRET_ERROR_CANARY')
    } } })
    assert.equal(report.status, 'failed')
    if (target === 'key') assert.equal(report.copy.status, 'copy_failed')
    else assert.deepEqual(report.connection, { status: 'failed', stage: 'known-hosts-file', reason: 'operation_failed' })
    assert.equal(report.cleanup, 'removed')
    assertSafe(report, original)
    assertClean(directory)
  }
  for (const cleanupFails of [false, true]) {
    const report = diagnoseKey(key, { ...options,
      filesystem: cleanupFails ? { ...fs, rmSync() { throw new Error('SECRET_ERROR_CANARY') } } : fs,
      execute(command, args, settings) {
        if (command !== 'ssh') return spawnSync(command, args, settings)
        if (!cleanupFails) throw new Error('SECRET_ERROR_CANARY')
        return { status: 0, stdout: 'ci_probe\n' }
      },
    })
    assert.equal(report.status, 'failed')
    assert.equal(report.cleanup, cleanupFails ? 'failed' : 'removed')
    assertSafe(report, original)
    if (!cleanupFails) assertClean(directory)
  }
  assert.ok(fs.existsSync(hosts))
}))

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

test('CLI --connect enables the read-only probe without logging child output', () => connectionFixture(({ directory, key, original, connection }) => {
  const bin = join(directory, 'bin')
  fs.mkdirSync(bin)
  fs.writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nprintf "ci_probe\\n"\nprintf "SECRET_ERROR_CANARY\\n" >&2\n', { mode: 0o700 })
  const result = spawnSync(process.execPath, [script, '--connect'], {
    encoding: 'utf8', env: { PATH: bin + ':' + process.env.PATH, SSH_PRIVATE_KEY: key, TMPDIR: directory, ...connection },
  })
  assert.equal(result.status, 0)
  assert.equal(result.stderr, '')
  const report = JSON.parse(result.stdout)
  assert.equal(report.connection.status, 'ok')
  assert.equal(report.cleanup, 'removed')
  assertSafe(report, original)
  assert.doesNotMatch(result.stdout, /vps\.example\.test|ci_probe|KNOWN_HOSTS_PATH_CANARY/)
  assertClean(directory)
}))

test('CI diagnostics stay manual and connect only on protected main with no artifacts or deployment commands', () => {
  const yaml = fs.readFileSync(new URL('../../.gitlab-ci.yml', import.meta.url), 'utf8')
  assert.match(yaml.split(/^release-checks:\r?$/m)[1]?.split(/^(?=\S)/m)[0] || '', /docker\/release\/ssh-key-diagnostics\.test\.mjs/)
  const job = yaml.split(/^diagnose-ssh-key:\r?$/m)[1]?.split(/^(?=\S)/m)[0]
  assert.ok(job)
  assert.match(job, /stage: code-quality/)
  assert.match(job, /image: node:24-alpine/)
  assert.match(job, /needs: \[\]/)
  assert.match(job, /allow_failure: true/)
  assert.match(job, /timeout: 3m/)
  assert.match(job, /when: manual/)
  assert.match(job, /when: never/)
  assert.match(job, /apk add --no-cache openssh-client/)
  assert.equal(job.split(/  script:\r?\n/)[1].trim(), '- node docker/release/ssh-key-diagnostics.mjs --connect')
  assert.doesNotMatch(job, /dependencies:|artifacts:|trigger:|extends:|environment:|variables:|deploy-ssh|deploy-production|docker push|ssh /)
  assert.equal(job.match(/- if: '([^']+)'/)[1], '$CI_PIPELINE_SOURCE == "push" && $CI_COMMIT_BRANCH == "main" && $CI_COMMIT_REF_PROTECTED == "true"')
  const available = env => env.CI_PIPELINE_SOURCE === 'push' && env.CI_COMMIT_BRANCH === 'main' && env.CI_COMMIT_REF_PROTECTED === 'true'
  for (const branch of ['main', 'feature/task-12-frontend']) {
    for (const protectedRef of ['true', 'false']) {
      assert.equal(available({ CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: branch, CI_COMMIT_REF_PROTECTED: protectedRef }), branch === 'main' && protectedRef === 'true')
    }
  }
  for (const context of [
    { CI_PIPELINE_SOURCE: 'push', CI_COMMIT_TAG: 'v1.0.1', CI_COMMIT_REF_PROTECTED: 'true' },
    { CI_PIPELINE_SOURCE: 'merge_request_event', CI_COMMIT_BRANCH: 'main', CI_COMMIT_REF_PROTECTED: 'true' },
    { CI_PIPELINE_SOURCE: 'web', CI_COMMIT_BRANCH: 'main', CI_COMMIT_REF_PROTECTED: 'true' },
    { CI_PIPELINE_SOURCE: 'schedule', CI_COMMIT_BRANCH: 'main', CI_COMMIT_REF_PROTECTED: 'true' },
  ]) assert.equal(available(context), false)
})
