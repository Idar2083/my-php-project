import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'

const header = Buffer.from('-----BEGIN OPENSSH PRIVATE KEY-----\n')
const footer = Buffer.from('-----END OPENSSH PRIVATE KEY-----\n')

function checkKey(path, execute) {
  try {
    const result = execute('ssh-keygen', ['-y', '-P', '', '-f', path], {
      stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 30000, maxBuffer: 65536,
    })
    if (result.error) return result.error.code === 'ENOENT' ? 'not_found'
      : result.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn_failed'
    if (result.signal) return 'terminated'
    if (result.status === 0) return 'ok'
    const stderr = String(result.stderr || '')
    if (/incorrect passphrase|bad passphrase/i.test(stderr)) return 'passphrase_error'
    if (/error in libcrypto/.test(stderr)) return 'libcrypto_error'
    if (/invalid format/.test(stderr)) return 'invalid_format'
    return 'failed'
  } catch { return 'spawn_failed' }
}

function inspect(path, filesystem, execute) {
  const result = { status: 'skipped', exists: null, type: null, size_bytes: null,
    sha256: null, lf_count: null, crlf_count: null, header_ok: null,
    footer_ok: null, trailing_lf: null, ssh_keygen: 'skipped' }
  if (typeof path !== 'string' || !path) return { ...result, status: 'missing_path' }
  try {
    const stat = filesystem.lstatSync(path)
    result.exists = true
    result.type = stat.isFile() ? 'regular_file' : stat.isDirectory() ? 'directory'
      : stat.isSymbolicLink() ? 'symlink' : 'other'
    result.size_bytes = stat.size
    if (!stat.isFile()) return { ...result, status: 'not_regular_file' }
    const bytes = filesystem.readFileSync(path)
    result.sha256 = createHash('sha256').update(bytes).digest('hex')
    result.lf_count = 0;result.crlf_count = 0
    for (let i = 0; i < bytes.length; i++) {
      if (bytes[i] === 10) {
        result.lf_count++
        if (i > 0 && bytes[i - 1] === 13) result.crlf_count++
      }
    }
    result.header_ok = bytes.subarray(0, header.length).equals(header)
    result.footer_ok = bytes.length >= footer.length && bytes.subarray(-footer.length).equals(footer)
    result.trailing_lf = bytes.at(-1) === 10
    result.ssh_keygen = checkKey(path, execute)
    result.status = 'ok'
  } catch (error) {
    if (error?.code === 'ENOENT') { result.exists = false;result.status = 'missing_file' }
    else result.status = 'inspection_failed'
  }
  return result
}

function connectionFailure(result) {
  if (result.error) return result.error.code === 'ENOENT' ? 'not_found'
    : result.error.code === 'ETIMEDOUT' ? 'timeout' : 'spawn_failed'
  if (result.signal) return 'terminated'
  if (result.status === 0) return null
  const stderr = String(result.stderr || '')
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key verification failed/i.test(stderr)) return 'host_key_error'
  if (/Permission denied|Authentication failed/i.test(stderr)) return 'authentication_failed'
  if (/Could not resolve hostname|Name or service not known|Temporary failure in name resolution/i.test(stderr)) return 'dns_error'
  if (/Connection refused/i.test(stderr)) return 'connection_refused'
  if (/Connection timed out|Operation timed out/i.test(stderr)) return 'timeout'
  return 'failed'
}

function checkConnection(env, key, temporary, filesystem, execute) {
  const result = { status: 'failed', stage: 'ssh-configuration', reason: 'invalid_configuration' }
  if (!/^[a-z_][a-z0-9_-]*$/.test(env.DEPLOY_USER || '') || env.DEPLOY_USER === 'root' ||
      !/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(env.DEPLOY_HOST || '') ||
      !/^\d{1,5}$/.test(env.DEPLOY_PORT || '') || +env.DEPLOY_PORT < 1 || +env.DEPLOY_PORT > 65535 ||
      typeof env.SSH_KNOWN_HOSTS !== 'string' || !env.SSH_KNOWN_HOSTS) return result
  try {
    result.stage = 'known-hosts-file'
    if (!filesystem.lstatSync(env.SSH_KNOWN_HOSTS).isFile()) return { ...result, reason: 'not_regular_file' }
    const hosts = join(temporary, 'known_hosts')
    filesystem.writeFileSync(hosts, filesystem.readFileSync(env.SSH_KNOWN_HOSTS), { flag: 'wx', mode: 0o600 })
    result.stage = 'known-hosts-format'
    const lines = filesystem.readFileSync(hosts, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
    if (!lines.length || !lines.every(line => /^\S+ (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: .*)?$/.test(line))) {
      return { ...result, reason: 'invalid_format' }
    }
    const host = +env.DEPLOY_PORT === 22 ? env.DEPLOY_HOST : '[' + env.DEPLOY_HOST + ']:' + env.DEPLOY_PORT
    for (const [stage, args] of [
      ['known-hosts-validation', ['-l', '-f', hosts]],
      ['known-hosts-match', ['-F', host, '-f', hosts]],
    ]) {
      result.stage = stage
      const checked = execute('ssh-keygen', args, {
        stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8', timeout: 10000, killSignal: 'SIGKILL', maxBuffer: 65536,
      })
      const reason = connectionFailure(checked)
      if (reason) return { ...result, reason }
    }
    result.stage = 'ssh-handshake'
    const checked = execute('ssh', ['-F', '/dev/null', '-T', '-p', env.DEPLOY_PORT, '-i', key,
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'UserKnownHostsFile=' + hosts, '-o', 'ConnectTimeout=15',
      '-o', 'PasswordAuthentication=no', '-o', 'PreferredAuthentications=publickey',
      env.DEPLOY_USER + '@' + env.DEPLOY_HOST, 'id -un'], {
      stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 30000, killSignal: 'SIGKILL', maxBuffer: 65536,
    })
    const reason = connectionFailure(checked)
    if (reason) return { ...result, reason }
    if (String(checked.stdout || '').trim() !== env.DEPLOY_USER) return { ...result, stage: 'remote-user', reason: 'unexpected_user' }
    return { status: 'ok', stage: 'remote-user', reason: 'ok' }
  } catch { return { ...result, reason: 'operation_failed' } }
}

// Only explicit metadata and fixed statuses leave this module. Never log paths,
// exceptions, file contents or child output. Network access requires connection.
export function diagnoseKey(path, { filesystem = fs, execute = spawnSync, temporaryRoot = os.tmpdir(), connection } = {}) {
  const report = { status: 'failed', source: inspect(path, filesystem, execute), copy: { status: 'skipped' }, cleanup: 'not_needed' }
  if (report.source.status !== 'ok') return report
  let temporary
  try {
    temporary = filesystem.mkdtempSync(join(temporaryRoot, 'pizza-key-diagnostics-'))
    const key = join(temporary, 'key')
    // Match deploy-ssh.mjs: read a Buffer and write it unchanged, exclusively, 0600.
    filesystem.writeFileSync(key, filesystem.readFileSync(path), { flag: 'wx', mode: 0o600 })
    report.copy = inspect(key, filesystem, execute)
    if (report.copy.status === 'ok' && report.source.sha256 === report.copy.sha256 &&
        report.copy.ssh_keygen === 'ok') report.status = 'ok'
    if (connection) {
      report.connection = report.status === 'ok' ? checkConnection(connection, key, temporary, filesystem, execute) : { status: 'skipped' }
      if (report.connection.status !== 'ok') report.status = 'failed'
    }
  } catch { report.copy = { status: 'copy_failed' } } finally {
    if (temporary) {
      try {
        filesystem.rmSync(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 })
        report.cleanup = 'removed'
      } catch { report.cleanup = 'failed';report.status = 'failed' }
    }
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const connect = process.argv.length === 3 && process.argv[2] === '--connect'
    const report = process.argv.length === 2 || connect
      ? diagnoseKey(process.env.SSH_PRIVATE_KEY, connect ? { connection: process.env } : {}) : { status: 'invalid_arguments' }
    process.stdout.write(JSON.stringify(report) + '\n')
    process.exitCode = report.status === 'ok' ? 0 : 1
  } catch {
    process.stdout.write('{"status":"diagnostic_failed"}\n')
    process.exitCode = 1
  }
}
