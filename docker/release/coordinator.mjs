import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { advance, assertOperationLock, assertNoRecovery, begin, checkBackupCandidate, checkCandidate, identity, persist, readState } from './state.mjs'
import { checkBackupReadiness, config, createBackup, preflight, recordVerifiedBackup, restoreTest, verifyBackup } from './backup.mjs'
import { ensure, readJson } from './backup-format.mjs'
import { validate as validateManifest } from './manifest.mjs'
import { DockerCoordinator } from './coordinator-docker.mjs'

export function privateDirectory(directory) {
  const stat = fs.lstatSync(directory)
  ensure(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0)
}
export function savePlan(path, directory, plan) {
  const temporary = fs.mkdtempSync(join(directory, '.quiesce-'))
  try {
    const staged = join(temporary, 'plan.json')
    fs.writeFileSync(staged, JSON.stringify(plan) + '\n', { flag: 'wx', mode: 0o600, flush: true })
    fs.linkSync(staged, path)
    const fd = fs.openSync(directory, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } finally { fs.rmSync(temporary, { recursive: true }) }
}

export function configurationHash(configuration, settings, backupRoot) {
  return jsonHash([configuration, settings, fs.realpathSync(backupRoot)])
}
export function jsonHash(value) {
  return createHash('sha256').update(JSON.stringify(value, (_, item) => item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item)).digest('hex')
}

function prepare(directory, manifest, bundle, runtime, backupRoot, driver, includeBackup = false) {
  assertOperationLock(directory)
  privateDirectory(directory)
  validateManifest(manifest)
  let state = readState(directory)
  assertNoRecovery(directory, manifest)
  checkCandidate(state, manifest)
  ensure(driver.backup.config.project === state.project, 'BACKUP_PROJECT_MISMATCH')
  ensure(!state.operation || ['prepared', 'images_ready', 'quiescing', 'quiesced', ...(includeBackup ? ['backup_ready'] : [])].includes(state.operation.phase), 'UNSUPPORTED_RELEASE_PHASE')
  const next = begin(state, manifest)
  const configuration = driver.check(state, manifest, bundle, runtime)
  // An already committed release is never quiesced again by a retry.
  if (!next.operation) return state
  driver.snapshot(state)
  if (!state.operation) { persist(directory, state, next); state = next }
  if (state.operation.phase === 'prepared') {
    driver.images(manifest, true)
    const ready = advance(state, manifest, 'images_ready')
    persist(directory, state, ready)
    state = ready
  } else driver.images(manifest)

  const readyRevision = state.revision - ({ images_ready: 0, quiescing: 1, quiesced: 2, backup_ready: 3 }[state.operation.phase])
  const planPath = join(directory, `quiesce-${identity(manifest)}-${readyRevision}.json`)
  const expected = { schema_version: 1, project: state.project, operation_id: identity(manifest), state_revision: readyRevision,
    configuration_sha256: configurationHash(configuration, driver.backup.config, backupRoot), writers: driver.snapshot(state) }
  let receipt
  if (state.operation.phase === 'images_ready') {
    receipt = preflight(state, backupRoot, driver.backup)
    if (!fs.existsSync(planPath)) savePlan(planPath, directory, expected)
  } else if (!includeBackup || state.operation.phase === 'quiescing') checkBackupReadiness(state, backupRoot, driver.backup)
  // No resuming against changed topology, image, runtime configuration or a
  // container restarted since the original plan. Plans never contain secrets.
  const plan = readJson(planPath)
  ensure(isDeepStrictEqual(plan, expected), 'QUIESCE_PLAN_CHANGED')
  if (state.operation.phase === 'images_ready') {
    const stopping = advance(state, manifest, 'quiescing')
    persist(directory, state, stopping, { preflight: receipt })
    state = stopping
  }
  if (state.operation.phase === 'quiescing') {
    for (const writer of plan.writers) {
      ensure(isDeepStrictEqual(driver.snapshot(state), plan.writers), 'WRITERS_CHANGED')
      driver.stop(writer, state.project)
    }
  }
  ensure(isDeepStrictEqual(driver.snapshot(state), plan.writers), 'WRITERS_CHANGED')
  driver.quiesced()
  if (state.operation.phase === 'quiescing') {
    const stopped = advance(state, manifest, 'quiesced')
    persist(directory, state, stopped)
    state = stopped
  }
  return state
}

export function prepareBackup(directory, manifest, bundle, runtime, backupRoot, driver) {
  return prepare(directory, manifest, bundle, runtime, backupRoot, driver)
}

function entry(path) {
  try { return fs.lstatSync(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error }
}

export function backupRelease(directory, manifest, bundle, runtime, backupRoot, driver) {
  assertOperationLock(directory)
  // A retry that reuses a completed copy still needs a trusted backup root, but
  // must not require enough free space to create an unnecessary second copy.
  privateDirectory(backupRoot)
  const state = prepare(directory, manifest, bundle, runtime, backupRoot, driver, true)
  if (!state.operation) return { state, backupPath: null }
  const revision = state.revision - (state.operation.phase === 'backup_ready' ? 1 : 0)
  let backupPath
  for (let attempt = 0; ; attempt++) {
    ensure(Number.isSafeInteger(attempt), 'BACKUP_ATTEMPTS_EXHAUSTED')
    const id = createHash('sha256').update(JSON.stringify([state.project, identity(manifest), revision, attempt])).digest('hex')
    const path = join(backupRoot, id)
    if (entry(path)) { backupPath = path; break }
    const claim = entry(join(backupRoot, `.claim-${id}`))
    if (claim) {
      ensure(claim.isDirectory() && claim.uid === process.getuid() && (claim.mode & 0o077) === 0, 'INVALID_BACKUP_CLAIM')
      continue
    }
    ensure(state.operation.phase === 'quiesced', 'VERIFIED_BACKUP_MISSING')
    backupPath = createBackup(state, backupRoot, id, driver.backup)
    break
  }
  // Validate ownership/revision before attempting a restore. Never skip an
  // existing published copy on verification failure or silently replace it.
  checkBackupCandidate(state, manifest, verifyBackup(backupPath, driver.backup))
  restoreTest(backupPath, driver.backup)
  // Recheck the original durable plan, not a fresh baseline captured after the
  // copy: a restart/configuration change during dump/verify/restore must fail.
  prepare(directory, manifest, bundle, runtime, backupRoot, driver, true)
  // Reuses TOC, file hashes, candidate binding and atomic state persistence.
  // No phase can advance to backup_ready before the restore test above succeeds.
  recordVerifiedBackup(directory, manifest, backupPath, driver.backup, 'backup_ready')
  return { state: readState(directory), backupPath }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, directory, manifestPath, bundle, runtime, settingsPath, backupRoot, ...extra] = process.argv.slice(2)
    ensure(['prepare-backup', 'backup'].includes(command) && backupRoot && !extra.length)
    const driver = new DockerCoordinator(config(readJson(settingsPath)))
    const args = [resolve(directory), validateManifest(readJson(manifestPath)), resolve(bundle), resolve(runtime), resolve(backupRoot), driver]
    if (command === 'backup') {
      const result = backupRelease(...args)
      console.log(result.backupPath ? JSON.stringify({ phase: 'backup_ready', backup_path: result.backupPath }) : 'Release already current; no changes performed.')
    } else {
      const state = prepareBackup(...args)
      console.log(state.operation ? 'Release phase: quiesced. Ready for backup; no migrations performed.' : 'Release already current; no changes performed.')
    }
  } catch {
    process.stderr.write('Release coordination failed: verify state, manifest, configuration, images, container status and operation journals.\n')
    process.exitCode = 1
  }
}
