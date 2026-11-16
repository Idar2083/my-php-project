import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'

export const files = ['postgres.dump', 'globals.sql', 'minio.zip']
export function ensure(value, code = 'INVALID_BACKUP') { if (!value) throw new Error(code) }
export function fields(value, keys) {
  ensure(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === [...keys].sort().join())
}
export function digest(path) {
  ensure(fs.lstatSync(path).isFile())
  const hash = createHash('sha256'), buffer = Buffer.alloc(1024 * 1024)
  const fd = fs.openSync(path, 'r')
  try { for (let n; (n = fs.readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, n)) } finally { fs.closeSync(fd) }
  return hash.digest('hex')
}
export function readJson(path) { ensure(fs.lstatSync(path).isFile()); return JSON.parse(fs.readFileSync(path, 'utf8')) }
export function validateMetadata(m) {
  fields(m, ['schema_version', 'backup_id', 'created_at', 'project', 'release_id', 'git_sha', 'operation_id', 'state_revision', 'postgres', 'minio', 'files'])
  ensure(m.schema_version === 1 && typeof m.backup_id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(m.backup_id))
  ensure(typeof m.created_at === 'string' && new Date(m.created_at).toISOString() === m.created_at)
  ensure(typeof m.project === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(m.project))
  for (const key of ['release_id', 'operation_id']) ensure(typeof m[key] === 'string' && /^[a-f0-9]{64}$/.test(m[key]))
  ensure(typeof m.git_sha === 'string' && /^[a-f0-9]{40}$/.test(m.git_sha))
  ensure(Number.isSafeInteger(m.state_revision) && m.state_revision >= 0)
  fields(m.postgres, ['server_version', 'image', 'format', 'globals'])
  fields(m.minio, ['image', 'format'])
  for (const image of [m.postgres.image, m.minio.image]) ensure(typeof image === 'string' && /^sha256:[a-f0-9]{64}$/.test(image))
  ensure(typeof m.postgres.server_version === 'string' && /^\d+\.\d+(?:\.\d+)?(?: \([A-Za-z0-9 .+~:/_-]+\))?$/.test(m.postgres.server_version))
  ensure(m.postgres.format === 'custom' && m.postgres.globals === 'no-role-passwords' && m.minio.format === 'offline-zip-v1')
  ensure(Array.isArray(m.files) && m.files.length === files.length)
  for (const [i, file] of m.files.entries()) {
    fields(file, ['name', 'bytes', 'sha256'])
    ensure(file.name === files[i] && Number.isSafeInteger(file.bytes) && file.bytes > 0 && typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256))
  }
  return m
}
export function verifyFiles(directory, staged = false) {
  ensure(fs.lstatSync(directory).isDirectory())
  ensure(fs.readdirSync(directory).sort().join() === [...files, 'metadata.json', 'COMPLETE'].sort().join())
  const m = validateMetadata(readJson(join(directory, 'metadata.json')))
  ensure(staged || basename(directory) === m.backup_id, 'UNPUBLISHED_BACKUP')
  ensure(fs.lstatSync(join(directory, 'COMPLETE')).isFile())
  ensure(fs.readFileSync(join(directory, 'COMPLETE'), 'utf8') === digest(join(directory, 'metadata.json')) + '\n')
  for (const file of m.files) {
    const path = join(directory, file.name)
    ensure(fs.lstatSync(path).isFile() && fs.statSync(path).size === file.bytes && digest(path) === file.sha256)
  }
  return m
}
export function verifyPreflight(path, project, operation, revision) {
  const m = readJson(path)
  fields(m, ['schema_version', 'project', 'operation_id', 'state_revision', 'checked_at', 'expires_at'])
  ensure(m.schema_version === 1 && m.project === project && m.operation_id === operation && m.state_revision === revision)
  ensure(Number.isFinite(Date.parse(m.checked_at)) && Date.parse(m.checked_at) <= Date.now() && Date.parse(m.expires_at) > Date.now() && Date.parse(m.expires_at) - Date.parse(m.checked_at) === 900000)
  return m
}
