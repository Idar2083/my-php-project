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

// Only explicit metadata and fixed statuses leave this module. Never log paths,
// exceptions, file contents or child output. This does not contact any server.
export function diagnoseKey(path, { filesystem = fs, execute = spawnSync, temporaryRoot = os.tmpdir() } = {}) {
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
        report.source.ssh_keygen === 'ok' && report.copy.ssh_keygen === 'ok') report.status = 'ok'
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
    const report = process.argv.length === 2 ? diagnoseKey(process.env.SSH_PRIVATE_KEY) : { status: 'invalid_arguments' }
    process.stdout.write(JSON.stringify(report) + '\n')
    process.exitCode = report.status === 'ok' ? 0 : 1
  } catch {
    process.stdout.write('{"status":"diagnostic_failed"}\n')
    process.exitCode = 1
  }
}
