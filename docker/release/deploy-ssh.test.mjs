import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { create } from './manifest.mjs'
import { buildBundle, bundleFiles, deployAllowed, hash, parseBundle, serverRoot, verifyPublication } from './deploy-bundle.mjs'
import { deliver } from './deploy-ssh.mjs'
import { installBundle, receive, runCoordinator } from './deploy-server.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const env = { CI_PIPELINE_SOURCE: 'push', CI_COMMIT_REF_PROTECTED: 'true', CI_COMMIT_TAG: 'v1.2.3',
  CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123', CI_REGISTRY_IMAGE: 'registry.example.test/pizza' }
const manifest = create({ ...env, PHP_IMAGE: env.CI_REGISTRY_IMAGE + '/php@sha256:' + 'b'.repeat(64),
  NGINX_IMAGE: env.CI_REGISTRY_IMAGE + '/nginx@sha256:' + 'c'.repeat(64) })
const bundle = () => buildBundle(env, manifest, path => fs.readFileSync(join(root, path), 'utf8'))
function fixture(run) {
  const path = fs.mkdtempSync(join(os.tmpdir(), 'pizza-ssh-test-'))
  for (const name of ['releases', 'shared', 'shared/state', 'shared/backups']) fs.mkdirSync(join(path, name), { recursive: true, mode: 0o700 })
  try { return run(path) } finally { fs.rmSync(path, { recursive: true }) }
}
async function asyncFixture(run) {
  const path = fs.mkdtempSync(join(os.tmpdir(), 'pizza-ssh-test-'))
  for (const name of ['releases', 'shared', 'shared/state', 'shared/backups']) fs.mkdirSync(join(path, name), { recursive: true, mode: 0o700 })
  try { return await run(path) } finally { fs.rmSync(path, { recursive: true }) }
}
// Evaluate the actual, deliberately small GitLab rules expressions, not a second policy.
const yaml = fs.readFileSync(join(root, '.gitlab-ci.yml'), 'utf8')
function rules(section) {
  const result = []
  for (const line of section.split('\n')) {
    const match = line.match(/- if: '(.+)'/)
    if (match) result.push({ expression: match[1] })
    else if (/^\s+- when: never/.test(line)) result.push({ expression: 'true', never: true })
    else if (/^\s+when: never/.test(line) && result.length) result.at(-1).never = true
  }
  return values => {
    const variables = { CI_DEFAULT_BRANCH: 'main', ...values }
    for (const rule of result) {
      let expression = rule.expression.replace(/\$(\w+) =~ (\/[^\n]+\/[a-z]*)/g, '($2).test(env.$1 || "")')
      expression = expression.replace(/\$(\w+)/g, 'env.$1')
      if (Function('env', 'return Boolean(' + expression + ')')(variables)) return !rule.never
    }
    return false
  }
}
test('actual CI rules preserve branch/MR pipelines and deploy only protected version tag pushes', () => {
  const workflow = rules(yaml.split('workflow:')[1].split('default:')[0])
  const deploy = rules(yaml.split('deploy-production:')[1])
  for (const context of [
    { CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: 'main' },
    { CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: 'feature/example' },
    { CI_PIPELINE_SOURCE: 'merge_request_event', CI_COMMIT_BRANCH: 'feature/example' },
  ]) { assert.equal(workflow(context), true);assert.equal(deploy(context), false) }
  assert.equal(workflow({ CI_PIPELINE_SOURCE: 'push', CI_COMMIT_BRANCH: 'feature/example', CI_OPEN_MERGE_REQUESTS: '1' }), false)
  assert.equal(workflow(env), true);assert.equal(deploy(env), true)
  for (const patch of [{ CI_COMMIT_REF_PROTECTED: 'false' }, { CI_COMMIT_TAG: 'v01.2.3' },
    { CI_COMMIT_TAG: 'v1.2.3-rc1' }, { CI_COMMIT_TAG: 'release' }, { CI_PIPELINE_SOURCE: 'web' },
    { CI_PIPELINE_SOURCE: 'merge_request_event' }]) {
    assert.equal(deploy({ ...env, ...patch }), false)
    assert.equal(deployAllowed({ ...env, ...patch }), false)
  }
  const job = yaml.split('deploy-production:')[1]
  assert.match(job, /stage: deploy/);assert.match(job, /resource_group: production-deploy/)
  assert.match(job, /name: production/);assert.doesNotMatch(job, /\bneeds:/)
  assert.match(job, /- release-manifest/);assert.match(job, /- publish-production/)
  assert.match(yaml, /docker\/release\/deploy-ssh.test.mjs/)
})
test('bundle binds version tag, SHA, pipeline, registry and exact committed file allowlist', () => {
  const value = bundle(), bytes = JSON.stringify(value)
  assert.deepEqual(parseBundle(bytes, value.release, hash(bytes)), value)
  assert.equal(bundleFiles.includes('.env'), false)
  assert.equal(bundleFiles.some(path => /testing|runtime\.env|\.test\.|support/.test(path)), false)
  for (const patch of [{ CI_COMMIT_REF_PROTECTED: 'false' }, { CI_COMMIT_TAG: 'v1.0.0-rc1' }, { CI_COMMIT_SHA: 'd'.repeat(40) },
    { CI_PIPELINE_ID: '124' }, { CI_REGISTRY_IMAGE: 'foreign.test/pizza' }]) {
    assert.throws(() => buildBundle({ ...env, ...patch }, manifest, () => 'fixture'))
  }
  for (const mutate of [v => { v.files['../escape'] = v.files[bundleFiles[0]] },
    v => { delete v.files[bundleFiles[0]] }, v => { v.files[bundleFiles[0]].content += 'changed' },
    v => { v.manifest.images.php = 'foreign.test/php@sha256:' + 'b'.repeat(64) },
    v => { v.manifest.secret = 'canary' }, v => { v.release.tag = 'v9.9.9' }]) {
    const changed = structuredClone(value);mutate(changed)
    const edited = JSON.stringify(changed)
    assert.throws(() => parseBundle(edited, value.release, hash(edited)))
  }
  assert.throws(() => parseBundle(bytes + ' ', value.release, hash(bytes)))
})
test('changed image digest is rejected against publication evidence even in a valid manifest', () => {
  const ids = ['sha256:' + 'b'.repeat(64), 'sha256:' + 'c'.repeat(64)]
  const evidence = ['php', 'nginx'].map((service, i) => ({ id: ids[i], digests: [manifest.images[service]] }))
  verifyPublication(env, manifest, ids.join('\n'), evidence)
  assert.throws(() => verifyPublication(env, { ...manifest, images: { ...manifest.images, php: env.CI_REGISTRY_IMAGE + '/php@sha256:' + 'd'.repeat(64) } }, ids.join('\n'), evidence))
  assert.throws(() => verifyPublication(env, manifest, ids.join('\n'), evidence.map(item => ({ ...item, id: 'sha256:' + 'e'.repeat(64) }))))
})
test('delivery requires SSH file variables, validates host keys, pins host checking and sends only JSON stdin', () => fixture(path => {
  const key = join(path, 'private'), hosts = join(path, 'hosts')
  fs.writeFileSync(key, 'fake-test-key');fs.writeFileSync(hosts, 'vps.example.test ssh-ed25519 AAAA\n')
  const config = { DEPLOY_HOST: 'vps.example.test', DEPLOY_USER: 'pizza', DEPLOY_PORT: '22', DEPLOY_ROOT: '/srv/pizza', SSH_PRIVATE_KEY: key, SSH_KNOWN_HOSTS: hosts }
  const calls = [], fake = (cmd, args, options) => { calls.push({ cmd, args, options });return '' }
  deliver(config, bundle(), fake)
  const ssh = calls.at(-1)
  assert.equal(ssh.cmd, 'ssh');assert.ok(ssh.args.includes('StrictHostKeyChecking=yes'))
  assert.ok(ssh.args.includes('BatchMode=yes'));assert.ok(ssh.args.includes('IdentitiesOnly=yes'))
  assert.match(ssh.args.at(-1), /^sh \/srv\/pizza\/deploy-tools\/deploy-server.sh \/srv\/pizza v1.2.3 /)
  assert.deepEqual(JSON.parse(ssh.options.input), bundle())
  assert.ok(calls.some(call => call.cmd === 'ssh-keygen' && call.args.includes('-F')))
  for (const name of Object.keys(config)) assert.throws(() => deliver({ ...config, [name]: '' }, bundle(), fake))
  for (const patch of [{ DEPLOY_USER: 'root' }, { DEPLOY_HOST: '-oProxyCommand=bad' }, { DEPLOY_ROOT: '/srv/../etc' }, { DEPLOY_PORT: '0' }]) {
    assert.throws(() => deliver({ ...config, ...patch }, bundle(), fake))
  }
  assert.throws(() => deliver(config, bundle(), () => { throw new Error('delivery interrupted') }))
  fs.writeFileSync(hosts, 'malformed')
  assert.throws(() => deliver(config, bundle(), fake))
}))
test('real ssh-keygen rejects invalid private key and unmatched or malformed known_hosts before SSH', () => fixture(path => {
  const key = join(path, 'key'), hosts = join(path, 'hosts')
  const result = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  assert.equal(result.status, 0)
  const publicKey = fs.readFileSync(key + '.pub', 'utf8').trim()
  const config = { DEPLOY_HOST: 'vps.example.test', DEPLOY_USER: 'pizza', DEPLOY_PORT: '22', DEPLOY_ROOT: '/srv/pizza', SSH_PRIVATE_KEY: key, SSH_KNOWN_HOSTS: hosts }
  fs.writeFileSync(hosts, 'vps.example.test ' + publicKey + '\n')
  let transferred = false
  deliver(config, bundle(), (command, args) => {
    if (command === 'ssh') { transferred = true;return '' }
    const checked = spawnSync(command, args, { encoding: 'utf8' })
    assert.equal(checked.status, 0)
    return checked.stdout
  })
  assert.equal(transferred, true)
  // Exercise the real subprocess/stdin path while replacing only the SSH executable.
  const bin = join(path, 'bin'), received = join(path, 'received.json')
  fs.mkdirSync(bin)
  fs.writeFileSync(join(bin, 'ssh'), '#!/bin/sh\ncat > "$PIZZA_TEST_DELIVERY"\n', { mode: 0o700 })
  const originalPath = process.env.PATH
  process.env.PATH = bin + ':' + originalPath
  process.env.PIZZA_TEST_DELIVERY = received
  try {
    deliver(config, bundle())
    assert.deepEqual(JSON.parse(fs.readFileSync(received, 'utf8')), bundle())
    fs.writeFileSync(join(bin, 'ssh'), '#!/bin/sh\nexit 1\n')
    assert.throws(() => deliver(config, bundle()))
  } finally { process.env.PATH = originalPath;delete process.env.PIZZA_TEST_DELIVERY }
  fs.writeFileSync(hosts, 'other.example.test ' + publicKey + '\n')
  assert.throws(() => deliver(config, bundle()))
  fs.writeFileSync(hosts, 'vps.example.test ssh-ed25519 AAAA\n')
  assert.throws(() => deliver(config, bundle()))
  fs.writeFileSync(key, 'invalid-key')
  fs.writeFileSync(hosts, 'vps.example.test ' + publicKey + '\n')
  assert.throws(() => deliver(config, bundle()))
}))
test('server validates before installing/importing; installation is atomic and identical retries preserve files', async () => asyncFixture(async path => {
  const value = bundle(), bytes = JSON.stringify(value)
  let loaded = false
  await assert.rejects(receive(path, bytes, value.release, '0'.repeat(64), async () => { loaded = true }))
  assert.equal(loaded, false);assert.deepEqual(fs.readdirSync(join(path, 'releases')), [])
  const installed = installBundle(path, bytes, value.release, hash(bytes))
  assert.equal(fs.readFileSync(join(installed.destination, '.env'), 'utf8'), '')
  const stat = fs.statSync(join(installed.destination, 'release.json'))
  installBundle(path, bytes, value.release, hash(bytes))
  assert.equal(fs.statSync(join(installed.destination, 'release.json')).ino, stat.ino)
  await assert.rejects(receive(path, bytes, value.release, hash(bytes)), /FIRST_BOOTSTRAP_REQUIRED/)
  fs.appendFileSync(join(installed.destination, 'docker-compose.prod.yml'), 'changed')
  assert.throws(() => installBundle(path, bytes, value.release, hash(bytes)))
  assert.throws(() => serverRoot('/srv/pizza;bad'))
}))
test('server refuses symlink destinations and unlisted files', () => fixture(path => {
  const value = bundle(), bytes = JSON.stringify(value)
  const installed = installBundle(path, bytes, value.release, hash(bytes))
  fs.writeFileSync(join(installed.destination, 'unlisted'), '')
  assert.throws(() => installBundle(path, bytes, value.release, hash(bytes)))
  fs.unlinkSync(join(installed.destination, 'unlisted'))
  const file = join(installed.destination, 'release.json'), copy = join(path, 'copy')
  fs.renameSync(file, copy);fs.symlinkSync(copy, file)
  assert.throws(() => installBundle(path, bytes, value.release, hash(bytes)))
}))
test('validated delivery supplies exact paths to the coordinator; a rejected candidate stops before backup', async () => asyncFixture(async path => {
  const value = bundle(), bytes = JSON.stringify(value), calls = []
  fs.writeFileSync(join(path, 'shared/state/state.json'), '{}', { mode: 0o600 })
  fs.writeFileSync(join(path, 'shared/runtime.env'), 'PRIVATE_CANARY=fixture', { mode: 0o600 })
  fs.writeFileSync(join(path, 'shared/backup-settings.json'), '{}', { mode: 0o600 })
  const api = { config: value => value, DockerCoordinator: class {}, assertOperationLock: () => calls.push('lock'),
    readState: () => ({ current: manifest, operation: null }), checkCandidate: () => calls.push('candidate'),
    backupRelease: (...args) => calls.push(['backup', args]), continueRelease: (...args) => calls.push(['continue', args]) }
  await receive(path, bytes, value.release, hash(bytes), async () => api)
  const [, args] = calls.find(call => call[0] === 'backup')
  assert.equal(args[0], join(path, 'shared/state'));assert.deepEqual(args[1], manifest)
  assert.equal(args[2], join(path, 'releases/v1.2.3-123'));assert.equal(args[3], join(path, 'shared/runtime.env'))
  assert.equal(args[4], join(path, 'shared/backups'))
  assert.equal(JSON.stringify(value).includes('PRIVATE_CANARY'), false)
  api.checkCandidate = () => { throw new Error('foreign candidate') };calls.length = 0
  await assert.rejects(receive(path, bytes, value.release, hash(bytes), async () => api), /foreign candidate/)
  assert.deepEqual(calls, ['lock'])
}))
test('adapter calls existing coordinator under its lock, resumes migrations, and never auto-recovers', () => {
  const calls = [], driver = {}, state = { current: manifest, operation: null }
  const api = { assertOperationLock: () => calls.push('lock'), readState: () => state,
    checkCandidate: () => calls.push('candidate'), backupRelease: (...args) => calls.push(['backup', args]),
    continueRelease: (...args) => { calls.push(['continue', args]);return 'completed' } }
  const args = ['/state', manifest, '/bundle', '/runtime', '/backups', driver]
  assert.equal(runCoordinator(api, ...args), 'completed')
  assert.deepEqual(calls.slice(0, 2), ['lock', 'candidate'])
  assert.deepEqual(calls.slice(2), [['backup', args], ['continue', args]])
  calls.length = 0
  assert.throws(() => runCoordinator(api, '/state', { ...manifest, pipeline_id: '122' }, '/bundle', '/runtime', '/backups', driver))
  assert.deepEqual(calls, ['lock'])
  state.operation = { phase: 'migrating' };calls.length = 0
  runCoordinator(api, ...args);assert.equal(calls.some(call => Array.isArray(call) && call[0] === 'backup'), false)
  api.continueRelease = () => { throw new Error('migration failed') }
  assert.throws(() => runCoordinator(api, ...args), /migration failed/)
  api.assertOperationLock = () => { throw new Error('busy') };calls.length = 0
  assert.throws(() => runCoordinator(api, ...args), /busy/);assert.deepEqual(calls, [])
})
test('SSH adapter uses the same nonblocking directory lock as release.sh', () => fixture(path => {
  const wrapper = join(root, 'docker/release/deploy-server.sh')
  const result = spawnSync('sh', ['-ec', 'exec 9<"$1/shared/state"; flock -n -x 9; sh "$2" "$1" v1.2.3 sha pipeline registry checksum', 'sh', path, wrapper], { encoding: 'utf8', timeout: 5000 })
  assert.notEqual(result.status, 0);assert.match(result.stderr, /lock is busy/)
}))
