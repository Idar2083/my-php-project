import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { buildBundle, hash, requireValue, serverRoot, verifyPublication } from './deploy-bundle.mjs'
function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'], ...options })
  requireValue(result.status === 0)
  return result.stdout
}
export function deliver(env, bundle, execute = run) {
  const root = serverRoot(env.DEPLOY_ROOT)
  requireValue(/^[a-z_][a-z0-9_-]*$/.test(env.DEPLOY_USER || '') && env.DEPLOY_USER !== 'root')
  requireValue(/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(env.DEPLOY_HOST || '') && /^\d{1,5}$/.test(env.DEPLOY_PORT || '') && +env.DEPLOY_PORT > 0 && +env.DEPLOY_PORT <= 65535)
  requireValue(env.SSH_PRIVATE_KEY && env.SSH_KNOWN_HOSTS)
  const temporary = fs.mkdtempSync(join(os.tmpdir(), 'pizza-ssh-'))
  try {
    const key = join(temporary, 'key'), hosts = join(temporary, 'known_hosts')
    for (const [source, target] of [[env.SSH_PRIVATE_KEY, key], [env.SSH_KNOWN_HOSTS, hosts]]) {
      requireValue(fs.statSync(source).isFile())
      fs.writeFileSync(target, fs.readFileSync(source), { flag: 'wx', mode: 0o600 })
    }
    const lines = fs.readFileSync(hosts, 'utf8').split(/\r?\n/).filter(line => line.trim() && !line.trim().startsWith('#'))
    requireValue(lines.length > 0 && lines.every(line => /^\S+ (ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521)) [A-Za-z0-9+/]+={0,2}(?: .*)?$/.test(line)))
    execute('ssh-keygen', ['-y', '-P', '', '-f', key])
    execute('ssh-keygen', ['-l', '-f', hosts])
    execute('ssh-keygen', ['-F', +env.DEPLOY_PORT === 22 ? env.DEPLOY_HOST : '[' + env.DEPLOY_HOST + ']:' + env.DEPLOY_PORT, '-f', hosts])
    const bytes = JSON.stringify(bundle)
    const release = bundle.release
    const arguments_ = [root, release.tag, release.sha, release.pipeline, release.registry, hash(bytes)]
    requireValue(arguments_.every(value => /^[A-Za-z0-9/:._-]+$/.test(value)))
    execute('ssh', ['-F', '/dev/null', '-p', env.DEPLOY_PORT, '-i', key,
      '-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=yes',
      '-o', 'UserKnownHostsFile=' + hosts, '-o', 'GlobalKnownHostsFile=/dev/null', '-o', 'ConnectTimeout=15',
      '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
      env.DEPLOY_USER + '@' + env.DEPLOY_HOST,
      'sh ' + root + '/deploy-tools/deploy-server.sh ' + arguments_.join(' ')],
    { input: bytes, timeout: 0, maxBuffer: 1024 * 1024 })
  } finally { fs.rmSync(temporary, { recursive: true }) }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const env = process.env
    // Resolve the actual repository tag, including annotated tags. No shell interpolation.
    requireValue(run('git', ['rev-parse', '--verify', 'refs/tags/' + env.CI_COMMIT_TAG + '^{commit}']).trim() === env.CI_COMMIT_SHA)
    const manifest = JSON.parse(fs.readFileSync('reports/release.json', 'utf8'))
    verifyPublication(env, manifest, fs.readFileSync('reports/production-images.ids', 'utf8'),
      ['php', 'nginx'].map(service => JSON.parse(fs.readFileSync('reports/published-' + service + '.json', 'utf8'))))
    deliver(env, buildBundle(env, manifest))
    console.log('Production coordinator completed successfully.')
  } catch {
    process.stderr.write('Production deployment stopped. Check protected tag, artifacts, SSH configuration and server release journal; no automatic rollback is attempted.\n')
    process.exitCode = 1
  }
}
