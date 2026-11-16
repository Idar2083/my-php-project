import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { assertOperationLock, checkBackupCandidate, checkCandidate, identity, persist, readState, recoveryTransition } from './state.mjs'
import { configurationHash, privateDirectory, savePlan } from './coordinator.mjs'
import { config, restoreTest, verifyBackup } from './backup.mjs'
import { ensure, readJson, verifyFiles } from './backup-format.mjs'
import { DockerCoordinator } from './coordinator-docker.mjs'
import { applicationServices, infrastructureServices, descriptor, ReleaseRuntime } from './release-runtime.mjs'
import { checkDatabase } from './release-run.mjs'
import { RecoveryRuntime } from './recovery-runtime.mjs'
import { validate as validateManifest } from './manifest.mjs'

const offsets = { backup_ready: 0, migrating: 1, migrated: 2, starting: 3, verified: 4 }

export function recoverRelease(directory, manifest, bundle, runtime, backupRoot, driver) {
  assertOperationLock(directory)
  privateDirectory(directory); privateDirectory(backupRoot)
  let state = readState(directory)
  checkCandidate(state, manifest)
  const folder = join(directory, `recovery-${identity(manifest)}`), planPath = join(folder, 'plan.json')
  if (!fs.existsSync(folder)) {
    ensure(state.current && state.operation && offsets[state.operation.phase] !== undefined, 'RECOVERY_NOT_ELIGIBLE')
    fs.mkdirSync(folder, { mode: 0o700 })
    const fd = fs.openSync(directory, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  }
  privateDirectory(folder)
  if (!fs.existsSync(planPath)) {
    ensure(state.current && state.operation && offsets[state.operation.phase] !== undefined, 'RECOVERY_NOT_ELIGIBLE')
    const configuration = driver.check(state, manifest, bundle, runtime)
    driver.images(state.current)
    const inventory = new ReleaseRuntime(driver, folder, { project: state.project }).inventory()
    const source = Object.fromEntries(Object.entries(inventory).map(([name, item]) => [name, descriptor(item)]))
    for (const name of [...applicationServices, ...infrastructureServices]) ensure(source[name], 'RECOVERY_SERVICE_MISSING')
    const mode = state.operation.phase === 'backup_ready' ? 'rollback' : 'manual'
    let backupState, backupPath
    const launchFolder = join(directory, `launch-${identity(manifest)}-${state.revision - offsets[state.operation.phase]}`)
    if (mode === 'rollback') {
      checkDatabase(configuration, inventory)
      ensure(!inventory['release-migration'], 'UNEXPECTED_MIGRATION_CONTAINER')
      // Reuse the completed backup and original quiesce evidence; never create a replacement.
      const quiesce = readJson(join(directory, `quiesce-${identity(manifest)}-${state.revision - 3}.json`))
      ensure(quiesce.configuration_sha256 === configurationHash(configuration, driver.backup.config, backupRoot), 'RECOVERY_CONFIG_CHANGED')
      const entries = fs.readdirSync(backupRoot).filter(name => /^[a-f0-9]{64}$/.test(name))
      const matches = entries.filter(name => {
        const metadata = readJson(join(backupRoot, name, 'metadata.json'))
        return metadata.operation_id === identity(manifest) && metadata.state_revision === state.revision - 1
      })
      ensure(matches.length === 1, 'RECOVERY_BACKUP_AMBIGUOUS')
      backupState = state; backupPath = join(backupRoot, matches[0])
      const writers = driver.snapshot(state)
      ensure(isDeepStrictEqual(writers, quiesce.writers), 'RECOVERY_SOURCE_CHANGED')
      for (const writer of writers) {
        const item = source[writer.service]
        ensure(item && item.id === writer.id && item.image === writer.image && item.started_at === writer.started_at && !item.running, 'RECOVERY_SOURCE_CHANGED')
      }
      driver.quiesced()
      const images = { php: driver.image(state.current.images.php), nginx: driver.image(state.current.images.nginx) }
      for (const name of applicationServices) ensure(source[name].image === images[name === 'nginx' ? 'nginx' : 'php'], 'RECOVERY_SOURCE_IMAGE_MISMATCH')
      if (fs.existsSync(join(launchFolder, 'plan.json'))) ensure(isDeepStrictEqual(source, readJson(join(launchFolder, 'plan.json')).source), 'RECOVERY_SOURCE_CHANGED')
    } else {
      const launchPlan = readJson(join(launchFolder, 'plan.json'))
      ensure(launchPlan.configuration_sha256 === configurationHash(configuration, driver.backup.config, backupRoot), 'RECOVERY_CONFIG_CHANGED')
      // Validate all existing launch receipts before adopting partially started containers.
      const launch = new ReleaseRuntime(driver, launchFolder, launchPlan)
      launch.guard()
      backupState = launchPlan.initial_state; backupPath = launchPlan.backup_path
    }
    checkBackupCandidate(backupState, manifest, verifyBackup(backupPath, driver.backup))
    const networks = Object.fromEntries(Object.entries(inventory.postgres.NetworkSettings.Networks).map(([name, value]) => [name, value.NetworkID]))
    ensure(Object.keys(networks).length && Object.values(networks).every(Boolean), 'RECOVERY_NETWORK_MISSING')
    const plan = { schema_version: 1, project: state.project, operation_id: identity(manifest), mode, initial_state: state,
      backup_state: backupState, backup_path: backupPath, source, networks,
      configuration_sha256: configurationHash(configuration, driver.backup.config, backupRoot) }
    // Recheck before publishing: never adopt a changed source as a new baseline.
    const check = new RecoveryRuntime(driver, folder, plan);check.guard()
    savePlan(planPath, folder, plan)
  }
  const plan = readJson(planPath)
  ensure(plan.schema_version === 1 && plan.project === state.project && plan.operation_id === identity(manifest), 'RECOVERY_PLAN_CONFLICT')
  const initial = plan.initial_state
  const pending = recoveryTransition(initial, plan.mode === 'rollback' ? 'rolling_back' : 'recovery_required')
  const completed = plan.mode === 'rollback' ? recoveryTransition(pending, 'rollback_complete') : null
  ensure(isDeepStrictEqual(state, initial) || isDeepStrictEqual(state, pending) || (completed && isDeepStrictEqual(state, completed)), 'RECOVERY_STATE_CHANGED')
  const action = new RecoveryRuntime(driver, folder, plan)
  const guard = action.guard.bind(action)
  action.guard = () => {
    ensure(configurationHash(driver.check(initial, manifest, bundle, runtime), driver.backup.config, backupRoot) === plan.configuration_sha256, 'RECOVERY_CONFIG_CHANGED')
    driver.images(initial.current)
    checkBackupCandidate(plan.backup_state, manifest, verifyFiles(plan.backup_path))
    const actualState = readState(directory)
    ensure(isDeepStrictEqual(actualState, initial) || isDeepStrictEqual(actualState, pending) || (completed && isDeepStrictEqual(actualState, completed)), 'RECOVERY_STATE_CHANGED')
    return guard()
  }
  checkBackupCandidate(plan.backup_state, manifest, verifyBackup(plan.backup_path, driver.backup))
  // Restore tests use only isolated resources; live PostgreSQL and MinIO are never restored.
  restoreTest(plan.backup_path, driver.backup)
  action.guard()
  if (isDeepStrictEqual(state, initial)) { persist(directory, state, pending, { recovery: planPath });state = pending }
  if (plan.mode === 'manual') {
    action.stopWriters()
    action.record('recovery-required', { event: 'recovery_required', reason: 'schema_may_have_changed', revision: state.revision })
    throw new Error('MANUAL_RECOVERY_REQUIRED')
  }
  action.restoreApplication()
  if (!isDeepStrictEqual(state, completed)) { persist(directory, state, completed, { recovery: planPath });state = completed }
  action.record('rollback-succeeded', { event: 'rollback_succeeded', project: state.project, release_id: identity(state.current), failed_release_id: identity(manifest), revision: state.revision })
  return state
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, directory, manifestPath, bundle, runtime, settings, backupRoot, ...extra] = process.argv.slice(2)
    ensure(command === 'rollback' && backupRoot && !extra.length)
    const state = recoverRelease(resolve(directory), validateManifest(readJson(manifestPath)), resolve(bundle), resolve(runtime), resolve(backupRoot), new DockerCoordinator(config(readJson(settings))))
    console.log(JSON.stringify({ event: 'rollback_succeeded', release_id: identity(state.current) }))
  } catch {
    process.stderr.write('Release recovery stopped: inspect state and recovery journal; schema changes require manual recovery. No automatic database restore is performed.\n')
    process.exitCode = 1
  }
}
