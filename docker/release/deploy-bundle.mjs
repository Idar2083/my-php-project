import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { validate } from './manifest.mjs'
import { publishedManifest } from './published-manifest.mjs'

export const versionPattern = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/
export const bundleFiles = [
  'docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.release.yml',
  ...['manifest.mjs', 'state.mjs', 'backup-format.mjs', 'backup.mjs', 'backup-docker.mjs',
    'coordinator.mjs', 'coordinator-docker.mjs', 'release-run.mjs', 'release-runtime.mjs',
    'recovery.mjs', 'recovery-runtime.mjs', 'bootstrap.mjs', 'restore-release.mjs',
    'restore-runtime.mjs', 'restore-data.mjs', 'release.sh', 'backup.sh',
    'release-readiness.php', 'minio-service-check.php', 'minio-snapshot.php'].map(name => 'docker/release/' + name),
].sort()
export const hash = value => createHash('sha256').update(value).digest('hex')
export function requireValue(condition) { if (!condition) throw new Error('DEPLOY_VALIDATION_FAILED') }
export function serverRoot(root) {
  requireValue(typeof root === 'string' && /^\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)+$/.test(root))
  return root
}
export function identity(value) {
  requireValue(value && versionPattern.test(value.tag) && /^[a-f0-9]{40}$/.test(value.sha) && /^[1-9]\d*$/.test(value.pipeline))
  requireValue(typeof value.registry === 'string' && /^[a-z0-9][a-z0-9.:/_-]+$/.test(value.registry))
  return value
}
export function deployAllowed(env) {
  return env.CI_PIPELINE_SOURCE === 'push' && env.CI_COMMIT_REF_PROTECTED === 'true' && versionPattern.test(env.CI_COMMIT_TAG || '')
}
export function validateBundle(bundle, expected) {
  identity(expected)
  requireValue(bundle && Object.keys(bundle).sort().join() === 'files,manifest,release,schema_version' && bundle.schema_version === 1)
  requireValue(JSON.stringify(bundle.release) === JSON.stringify(expected))
  const manifest = validate(bundle.manifest)
  requireValue(manifest.git_sha === expected.sha && manifest.pipeline_id === expected.pipeline)
  for (const service of ['php', 'nginx']) requireValue(manifest.images[service].startsWith(expected.registry + '/' + service + '@sha256:'))
  requireValue(bundle.files && Object.keys(bundle.files).sort().join() === bundleFiles.join())
  for (const file of Object.values(bundle.files)) {
    requireValue(file && Object.keys(file).sort().join() === 'content,sha256' && typeof file.content === 'string' && hash(file.content) === file.sha256)
  }
  return bundle
}
export function buildBundle(env, manifest, readCommit = path => execFileSync('git', ['show', env.CI_COMMIT_SHA + ':' + path], { encoding: 'utf8', maxBuffer: 1024 * 1024 })) {
  requireValue(deployAllowed(env))
  const release = identity({ tag: env.CI_COMMIT_TAG, sha: env.CI_COMMIT_SHA, pipeline: env.CI_PIPELINE_ID, registry: env.CI_REGISTRY_IMAGE })
  return validateBundle({ schema_version: 1, release, manifest, files: Object.fromEntries(bundleFiles.map(path => {
    const content = readCommit(path)
    return [path, { content, sha256: hash(content) }]
  })) }, release)
}
export function verifyPublication(env, manifest, ids, inspections) {
  const published = publishedManifest(env, ids, inspections)
  validate(manifest)
  requireValue(manifest.git_sha === published.git_sha && manifest.pipeline_id === published.pipeline_id &&
    manifest.images.php === published.images.php && manifest.images.nginx === published.images.nginx)
}
export function parseBundle(bytes, expected, checksum) {
  requireValue(bytes.length <= 2 * 1024 * 1024 && hash(bytes) === checksum)
  return validateBundle(JSON.parse(bytes), expected)
}
export function readPrivateFile(path) {
  const stat = fs.lstatSync(path)
  requireValue(stat.isFile() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0)
  return fs.readFileSync(path, 'utf8')
}
