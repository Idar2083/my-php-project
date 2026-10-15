import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { randomUUID } from 'node:crypto'
import { advance, assertOperationLock, checkBackupCandidate, identity, persist, readState } from './state.mjs'
import { validate as validateManifest } from './manifest.mjs'
import { DockerBackup } from './backup-docker.mjs'
import { digest, ensure, fields, files, readJson, validateMetadata, verifyFiles } from './backup-format.mjs'

export function config(value) {
  fields(value, ['schema_version', 'project', 'postgres_container', 'minio_container', 'utility_image', 'reserve_bytes'])
  ensure(value.schema_version === 1 && typeof value.project === 'string' && /^[a-z0-9][a-z0-9_-]*$/.test(value.project))
  for (const key of ['postgres_container', 'minio_container']) ensure(typeof value[key] === 'string' && /^[a-f0-9]{64}$/.test(value[key]))
  ensure(typeof value.utility_image === 'string' && /^sha256:[a-f0-9]{64}$/.test(value.utility_image))
  ensure(Number.isSafeInteger(value.reserve_bytes) && value.reserve_bytes >= 64 * 1024 * 1024)
  return value
}
function privateRoot(root) {
  const stat = fs.lstatSync(root)
  ensure(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0, 'BACKUP_ROOT_MUST_BE_PRIVATE')
}
function write(path, value) { fs.writeFileSync(path, value, { flag: 'wx', mode: 0o600, flush: true }) }
function syncDirectory(path) { const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) } }
function space(root, required, statfs = fs.statfsSync) {
  const stat = statfs(root, { bigint: true })
  ensure(stat.bavail * stat.bsize >= required, 'INSUFFICIENT_BACKUP_SPACE')
}
export function preflight(state, root, driver, statfs) {
  privateRoot(root)
  ensure(driver.config.project === state.project, 'BACKUP_PROJECT_MISMATCH')
  ensure(state.operation?.phase === 'images_ready', 'PREFLIGHT_REQUIRES_IMAGES_READY')
  driver.inventory(false)
  driver.preflightTools()
  space(root, driver.estimate() + BigInt(driver.config.reserve_bytes), statfs)
  const now = Date.now()
  const receipt = { schema_version: 1, project: state.project, operation_id: identity(state.operation.manifest),
    state_revision: state.revision, checked_at: new Date(now).toISOString(), expires_at: new Date(now + 900000).toISOString() }
  const path = join(root, `preflight-${randomUUID()}.json`)
  write(path, JSON.stringify(receipt) + '\n')
  syncDirectory(root)
  return path
}
export function createBackup(state, root, id, driver, statfs, hook = () => {}) {
  privateRoot(root)
  ensure(driver.config.project === state.project, 'BACKUP_PROJECT_MISMATCH')
  ensure(typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(id), 'INVALID_BACKUP_ID')
  ensure(state.operation?.phase === 'quiesced', 'BACKUP_REQUIRES_QUIESCED')
  const final = join(root, id)
  ensure(!fs.existsSync(final), 'BACKUP_ID_EXISTS')
  const writers = JSON.stringify(driver.inventory(true))
  driver.preflightTools()
  space(root, driver.estimate() + BigInt(driver.config.reserve_bytes), statfs)
  // A permanent private reservation prevents concurrent/reused IDs, including
  // reuse after SIGKILL. Never remove reservations automatically.
  try { fs.mkdirSync(join(root, `.claim-${id}`), { mode: 0o700 }) }
  catch (error) { if (error.code === 'EEXIST') throw new Error('BACKUP_ID_EXISTS'); throw error }
  const staged = fs.mkdtempSync(join(root, `.partial-${id}-`))
  let published = false
  try {
    hook('staging', staged)
    const source = state.current ?? state.operation.manifest
    const metadata = { schema_version: 1, backup_id: id, created_at: new Date().toISOString(), project: state.project,
      release_id: identity(source), git_sha: source.git_sha, operation_id: identity(state.operation.manifest), state_revision: state.revision,
      postgres: { server_version: driver.version(), image: driver.source.pgImage, format: 'custom', globals: 'no-role-passwords' },
      minio: { image: driver.source.minioImage, format: 'offline-zip-v1' }, files: [] }
    driver.dump(staged)
    driver.toc(staged, metadata)
    driver.snapshot(staged)
    ensure(JSON.stringify(driver.inventory(true)) === writers, 'WRITER_STATE_CHANGED')
    for (const name of files) {
      const path = join(staged, name), stat = fs.lstatSync(path)
      ensure(stat.isFile() && stat.size > 0, 'EMPTY_BACKUP_FILE')
      fs.chmodSync(path, 0o600)
      const fd = fs.openSync(path, 'r'); try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
      metadata.files.push({ name, bytes: stat.size, sha256: digest(path) })
    }
    validateMetadata(metadata)
    space(root, BigInt(driver.config.reserve_bytes), statfs)
    write(join(staged, 'metadata.json'), JSON.stringify(metadata, null, 2) + '\n')
    write(join(staged, 'COMPLETE'), digest(join(staged, 'metadata.json')) + '\n')
    verifyFiles(staged, true)
    syncDirectory(staged)
    hook('before-publication', staged)
    ensure(!fs.existsSync(final), 'BACKUP_ID_EXISTS')
    fs.renameSync(staged, final)
    syncDirectory(root)
    published = true
    return final
  } finally {
    if (!published && fs.existsSync(staged)) fs.rmSync(staged, { recursive: true })
  }
}
export function verifyBackup(directory, driver) {
  const metadata = verifyFiles(directory)
  ensure(metadata.project === driver.config.project, 'BACKUP_PROJECT_MISMATCH')
  driver.toc(directory, metadata)
  return metadata
}
export function restoreTest(directory, driver) {
  const metadata = verifyBackup(directory, driver)
  driver.restore(directory, metadata)
  return metadata
}

export function recordVerifiedBackup(stateDirectory, manifest, backupDirectory, driver, phase) {
  assertOperationLock(stateDirectory)
  const state = readState(stateDirectory)
  ensure(['backup_ready', 'migrating'].includes(phase), 'INVALID_BACKUP_TRANSITION')
  const previousPhase = phase === 'backup_ready' ? 'quiesced' : 'backup_ready'
  ensure(state.operation && [previousPhase, phase].includes(state.operation.phase), 'INVALID_BACKUP_TRANSITION')
  const metadata = verifyBackup(backupDirectory, driver)
  checkBackupCandidate(state, manifest, metadata)
  const next = state.operation.phase === phase ? state : advance(state, manifest, phase)
  persist(stateDirectory, state, next, { backup: backupDirectory })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, stateDirectory, ...args] = process.argv.slice(2)
    const recording = ['accept-backup', 'mark-migrating'].includes(command)
    const [manifestPath, configPath, target, id] = recording ? args : [null, ...args]
    ensure((recording || ['preflight', 'create', 'verify', 'restore-test'].includes(command)) && target &&
      args.length === (recording || command === 'create' ? 3 : 2), 'INVALID_BACKUP_ARGUMENTS')
    assertOperationLock(stateDirectory)
    const state = readState(stateDirectory), settings = config(readJson(configPath))
    ensure(settings.project === state.project, 'BACKUP_PROJECT_MISMATCH')
    const driver = new DockerBackup(settings)
    let result
    if (recording) recordVerifiedBackup(stateDirectory, validateManifest(readJson(manifestPath)), resolve(target), driver,
      command === 'accept-backup' ? 'backup_ready' : 'migrating')
    else if (command === 'preflight') result = preflight(state, resolve(target), driver)
    else if (command === 'create') result = createBackup(state, resolve(target), id, driver)
    else if (command === 'verify') verifyBackup(resolve(target), driver)
    else restoreTest(resolve(target), driver)
    if (recording) console.log(`Release phase: ${command === 'accept-backup' ? 'backup_ready' : 'migrating'}. No migrations performed.`)
    else if (result) console.log(result)
    else console.log('Backup verification passed.')
  } catch (error) {
    const code = ['INSUFFICIENT_BACKUP_SPACE', 'WRITERS_NOT_SAFELY_STOPPED', 'WRITER_STATE_CHANGED', 'BACKUP_REQUIRES_QUIESCED', 'PREFLIGHT_REQUIRES_IMAGES_READY', 'BACKUP_ID_EXISTS', 'BACKUP_ROOT_MUST_BE_PRIVATE', 'POSTGRES_HAS_ACTIVE_CLIENTS', 'MINIO_VOLUME_HAS_ACTIVE_WRITER'].includes(error.message) ? error.message : error.code === 'ENOSPC' ? 'INSUFFICIENT_BACKUP_SPACE' : 'BACKUP_OPERATION_FAILED'
    console.error(code)
    process.exitCode = 1
  }
}
