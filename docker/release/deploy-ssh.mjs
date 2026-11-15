import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { buildBundle, hash, requireValue, serverRoot, verifyPublication } from './deploy-bundle.mjs'
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], ...options })
  if (result.status !== 0 || result.error) throw Object.assign(new Error('CHILD_PROCESS_FAILED'), {
    status: result.status, stderr: result.stderr, code: result.error?.code, signal: result.signal,
  })
  return result.stdout
}
// Never print raw errors, arguments, stdout or stderr: any of them can contain secrets.
// Emit only fixed diagnostic text recognized in child stderr.
export function diagnostic(error, stage) {
  const category = stage !== 'ssh-command' ? stage
    : error?.status === 255 ? 'ssh-connection-or-transport'
      : Number.isInteger(error?.status) ? 'server-command' : 'ssh-process'
  const details = ['Production deployment failed [' + category + '].']
  if (Number.isInteger(error?.status)) details.push('exit_code=' + error.status)
  if (error?.status === null) details.push('status=null')
  if (['EAGAIN', 'ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ETIMEDOUT', 'ENOBUFS'].includes(error?.code)) details.push('system_code=' + error.code)
  if (['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGPIPE'].includes(error?.signal)) details.push('signal=' + error.signal)
  const stderr = String(error?.stderr || '')
  const messages = [
    [/invalid format/, 'Invalid key format.'],
    [/error in libcrypto/, 'Key parsing failed in libcrypto.'],
    [/incorrect passphrase|bad passphrase/, 'Private key requires a valid passphrase.'],
    [/is not a public key file/, 'Invalid known_hosts key file.'],
    [/Permission denied/, 'Permission denied.'],
    [/Host key verification failed/, 'Host key verification failed.'],
    [/REMOTE HOST IDENTIFICATION HAS CHANGED/, 'Remote host identification has changed.'],
    [/Could not resolve hostname/, 'Could not resolve hostname.'],
    [/Connection refused/, 'Connection refused.'],
    [/Connection timed out|Operation timed out/, 'Connection timed out.'],
    [/Network is unreachable|No route to host/, 'Host network is unreachable.'],
    [/deploy-server\.sh: (?:not found|No such file or directory)/, 'Server deployment wrapper not found.'],
    [/node: (?:not found|No such file or directory)/, 'Server Node.js executable not found.'],
    [/Production release lock is busy\./, 'Production release lock is busy.'],
    [/Validated bundle delivered\. Manual first bootstrap is required; no production services were started\./,
      'Validated bundle delivered. Manual first bootstrap is required; no production services were started.'],
    [/Production release stopped\. Preserve release bundle, state, backup and journals; inspect coordinator status\./,
      'Production release stopped. Inspect coordinator status and server journals.'],
  ]
  const safe = messages.filter(([pattern]) => pattern.test(stderr)).map(([, message]) => message)
  if (stderr) details.push('stderr: ' + (safe.join(' ') || '[unrecognized output withheld]'))
  return details.join(' ') + '\n'
}
function atStage(stage, action) {
  try { return action() } catch (error) {
    // Keep only our safe formatted message; never expose the original Error.message/stack.
    throw new Error(diagnostic(error, stage))
  }
}
export function deliver(env, bundle, execute = run) {
  let stage = 'ssh-configuration'
  try {
    const root = serverRoot(env.DEPLOY_ROOT)
    requireValue(/^[a-z_][a-z0-9_-]*$/.test(env.DEPLOY_USER || '') && env.DEPLOY_USER !== 'root')
    requireValue(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(env.DEPLOY_HOST || '') && /^\d{1,5}$/.test(env.DEPLOY_PORT || '') && +env.DEPLOY_PORT > 0 && +env.DEPLOY_PORT <= 65535)
    requireValue(env.SSH_PRIVATE_KEY && env.SSH_KNOWN_HOSTS)
    const temporary = fs.mkdtempSync(join(os.tmpdir(), 'pizza-ssh-'))
    try {
      const key = join(temporary, 'key'), hosts = join(temporary, 'known_hosts')
      for (const [source, target] of [[env.SSH_PRIVATE_KEY, key], [env.SSH_KNOWN_HOSTS, hosts]]) {
        stage = target === key ? 'private-key-file' : 'known-hosts-file'
        requireValue(fs.statSync(source).isFile())
        fs.writeFileSync(target, fs.readFileSync(source), { flag: 'wx', mode: 0o600 })
      }
      stage = 'known-hosts-format'
      const lines = fs.readFileSync(hosts, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
      requireValue(lines.length > 0 && lines.every(line => /^\S+ (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: .*)?$/.test(line)))
      stage = 'private-key-validation'
      execute('ssh-keygen', ['-y', '-P', '', '-f', key])
      stage = 'known-hosts-validation'
      execute('ssh-keygen', ['-l', '-f', hosts])
      stage = 'known-hosts-match'
      execute('ssh-keygen', ['-F', +env.DEPLOY_PORT === 22 ? env.DEPLOY_HOST : '[' + env.DEPLOY_HOST + ']:' + env.DEPLOY_PORT, '-f', hosts])
      stage = 'delivery-bundle'
      const bytes = JSON.stringify(bundle)
      const release = bundle.release
      const arguments_ = [root, release.tag, release.sha, release.pipeline, release.registry, hash(bytes)]
      requireValue(arguments_.every(value => /^[A-Za-z0-9/:._-]+$/.test(value)))
      stage = 'ssh-command'
      execute('ssh', ['-F', '/dev/null', '-p', env.DEPLOY_PORT, '-i', key,
        '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
        '-o', 'UserKnownHostsFile=' + hosts, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=15',
        '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
        env.DEPLOY_USER + '@' + env.DEPLOY_HOST,
        'sh ' + root + '/deploy-tools/deploy-server.sh ' + arguments_.join(' ')],
      { input: bytes, timeout: 0, maxBuffer: 1024 * 1024 })
    } finally {
      const failedStage = stage
      stage = 'ssh-cleanup'
      fs.rmSync(temporary, { recursive: true })
      stage = failedStage
    }
  } catch (error) { throw new Error(diagnostic(error, stage)) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env
    // Resolve the actual repository tag, including annotated tags. No shell interpolation.
    atStage('repository-tag', () => requireValue(run('git', ['rev-parse', '--verify', 'refs/tags/' + env.CI_COMMIT_TAG + '^{commit}']).trim() === env.CI_COMMIT_SHA))
    const manifest = atStage('release-manifest', () => JSON.parse(fs.readFileSync('reports/release.json', 'utf8')))
    atStage('publication-evidence', () => verifyPublication(env, manifest, fs.readFileSync('reports/production-images.ids', 'utf8'),
      ['php', 'nginx'].map(service => JSON.parse(fs.readFileSync('reports/published-' + service + '.json', 'utf8')))))
    deliver(env, atStage('bundle-build', () => buildBundle(env, manifest, path => run('git', ['show', env.CI_COMMIT_SHA + ':' + path], { timeout: 0, maxBuffer: 1024 * 1024 }))))
    console.log('Production coordinator completed successfully.')
  } catch (error) {
    process.stderr.write(error.message)
    process.stderr.write('Production deployment stopped. Check protected tag, artifacts, SSH configuration and server release journal; no automatic rollback is attempted.\n')
    process.exitCode = 1
  }
}
