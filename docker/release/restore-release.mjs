import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { assertOperationLock, checkBackupCandidate, identity, persist, readState, recoveryTransition } from './state.mjs'
import { configurationHash, jsonHash, privateDirectory, savePlan } from './coordinator.mjs'
import { config, verifyBackup } from './backup.mjs'
import { digest, ensure, readJson, verifyFiles } from './backup-format.mjs'
import { recoverRelease } from './recovery.mjs'
import { checkDatabase, deploymentModel } from './release-run.mjs'
import { applicationServices, descriptor, ReleaseRuntime } from './release-runtime.mjs'
import { RestoreRuntime } from './restore-runtime.mjs'
import { RestoreData } from './restore-data.mjs'
import { DockerCoordinator } from './coordinator-docker.mjs'
import { validate as validateManifest } from './manifest.mjs'

function modelFor(configuration, source, images, operation, volumes) {
  const model = deploymentModel(configuration, source, images, operation)
  delete model.services['release-migration']
  for (const name of ['postgres', 'minio']) model.services[name].labels = { ...model.services[name].labels, 'pizza.release-operation': operation }
  for (const [name, target] of [['postgres', '/var/lib/postgresql/data'], ['minio', '/data']]) {
    const mounts = model.services[name].volumes.filter(volume => volume.target === target && volume.type === 'volume')
    ensure(mounts.length === 1 && model.volumes[mounts[0].source], 'RESTORE_UNSUPPORTED_STORAGE')
    model.volumes[mounts[0].source] = { name: volumes[name], external: true }
  }
  return model
}

export function queuesEmpty(driver, id) {
  const queues = JSON.parse(driver.backup.run(['exec', '--user', 'rabbitmq', id, 'rabbitmqctl', 'list_queues', '-p', '/', '--formatter=json',
    'messages_ready', 'messages_unacknowledged']))
  ensure(Array.isArray(queues) && queues.every(queue => queue.messages_ready === 0 && queue.messages_unacknowledged === 0), 'RESTORE_QUEUES_NOT_EMPTY')
}

export function restoreRelease(directory, manifest, bundle, runtime, backupRoot, sourceBundle, sourceRuntime, driver, attempt = 1) {
  assertOperationLock(directory)
  privateDirectory(directory);privateDirectory(backupRoot)
  ensure(Number.isSafeInteger(attempt) && attempt > 0 && attempt <= 1000, 'RESTORE_INVALID_ATTEMPT')
  const recoveryFolder = join(directory, 'recovery-' + identity(manifest))
  const folder = join(recoveryFolder, 'restore')
  const rootPlan = join(folder, 'plan.json')
  if (!fs.existsSync(rootPlan)) {
    const before = readState(directory)
    ensure(before.current && ['migrating', 'migrated', 'starting', 'verified', 'recovery_required'].includes(before.operation?.phase), 'RESTORE_REQUIRES_FAILED_UPGRADE')
    // Preserve the old rollback behavior: after migrations it only quiesces and
    // records recovery_required. Data loss requires this separate explicit verb.
    try { recoverRelease(directory, manifest, bundle, runtime, backupRoot, driver) }
    catch (error) { ensure(error.message === 'MANUAL_RECOVERY_REQUIRED', 'RESTORE_QUIESCE_FAILED') }
    const state = readState(directory)
    ensure(state.current && state.operation?.phase === 'recovery_required', 'RESTORE_REQUIRES_FAILED_UPGRADE')
    const recovery = readJson(join(recoveryFolder, 'plan.json'))
    ensure(recovery.mode === 'manual' && identity(recovery.initial_state.operation.manifest) === identity(manifest), 'RESTORE_PLAN_CONFLICT')
    const configuration = driver.check(state, state.current, sourceBundle, sourceRuntime)
    driver.images(state.current)
    const inventory = new ReleaseRuntime(driver, folder, { project: state.project }).inventory()
    ensure(!inventory['release-migration']?.State.Running, 'RESTORE_MIGRATION_STILL_RUNNING')
    checkDatabase(configuration, inventory)
    const source = Object.fromEntries(Object.entries(inventory).map(([name, item]) => [name, descriptor(item)]))
    for (const name of [...applicationServices, 'minio', 'minio-init']) if (inventory[name]) ensure(!inventory[name].State.Running, 'RESTORE_WRITERS_RUNNING')
    const pg = configuration.services.postgres.environment
    ensure(pg.POSTGRES_DB && !['template0', 'template1'].includes(pg.POSTGRES_DB), 'RESTORE_DATABASE_UNSUPPORTED')
    queuesEmpty(driver, inventory.rabbitmq.Id)
    // Retain Redis/RabbitMQ exactly, including their live queues and caches.
    for (const name of ['redis', 'rabbitmq']) {
      const env = Object.fromEntries(inventory[name].Config.Env.map(value => { const i = value.indexOf('=');return [value.slice(0, i), value.slice(i + 1)] }))
      for (const [key, value] of Object.entries(configuration.services[name].environment || {})) ensure(env[key] === String(value).replaceAll('$$', '$'), 'RESTORE_INFRASTRUCTURE_CONFIG_CHANGED')
    }
    const metadata = verifyBackup(recovery.backup_path, driver.backup)
    checkBackupCandidate(recovery.backup_state, manifest, metadata)
    ensure(source.postgres.image === metadata.postgres.image && source.minio.image === metadata.minio.image, 'RESTORE_STORAGE_IMAGE_CHANGED')
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 })
    privateDirectory(folder)
    savePlan(rootPlan, folder, { schema_version: 1, initial_state: state, recovery_plan: join(recoveryFolder, 'plan.json'),
      source, networks: recovery.networks, source_bundle: sourceBundle, source_runtime: sourceRuntime,
      target_sha256: jsonHash(configuration), backup_sha256: digest(join(recovery.backup_path, 'COMPLETE')) })
  }
  privateDirectory(folder)
  const plan = readJson(rootPlan), recovery = readJson(plan.recovery_plan), initial = plan.initial_state
  ensure(initial.operation?.phase === 'recovery_required' && identity(initial.operation.manifest) === identity(manifest) &&
    sourceBundle === plan.source_bundle && sourceRuntime === plan.source_runtime, 'RESTORE_PLAN_CONFLICT')
  const metadata = verifyBackup(recovery.backup_path, driver.backup)
  checkBackupCandidate(recovery.backup_state, manifest, metadata)
  const id = jsonHash([identity(manifest), initial.revision, attempt])
  const volumes = { postgres: 'pizza-recovered-' + id.slice(0, 40) + '-pg', minio: 'pizza-recovered-' + id.slice(0, 40) + '-minio' }
  const completed = recoveryTransition(initial, 'recovery_complete', volumes)
  const check = () => {
    assertOperationLock(directory)
    ensure(isDeepStrictEqual(readState(directory), initial) || isDeepStrictEqual(readState(directory), completed), 'RESTORE_STATE_CHANGED')
    ensure(configurationHash(driver.check(recovery.initial_state, manifest, bundle, runtime), driver.backup.config, backupRoot) === recovery.configuration_sha256, 'RESTORE_SOURCE_CONFIG_CHANGED')
    ensure(jsonHash(driver.check(initial, initial.current, sourceBundle, sourceRuntime)) === plan.target_sha256, 'RESTORE_TARGET_CONFIG_CHANGED')
    ensure(digest(join(recovery.backup_path, 'COMPLETE')) === plan.backup_sha256, 'RESTORE_BACKUP_CHANGED')
    checkBackupCandidate(recovery.backup_state, manifest, verifyFiles(recovery.backup_path))
  }
  check()
  const promotionPath = join(folder, 'promotion.json')
  if (fs.existsSync(promotionPath)) ensure(readJson(promotionPath).attempt === attempt, 'RESTORE_PROMOTION_ALREADY_STARTED')
  if (attempt > 1) {
    const previous = join(folder, 'data-' + (attempt - 1))
    ensure(fs.existsSync(join(previous, 'failed.json')) && fs.existsSync(join(previous, 'abandoned.json')), 'RESTORE_PREVIOUS_ATTEMPT_AMBIGUOUS')
  }
  const dataFolder = join(folder, 'data-' + attempt), launchFolder = join(folder, 'launch-' + attempt)
  for (const path of [dataFolder, launchFolder]) {
    if (!fs.existsSync(path)) fs.mkdirSync(path, { mode: 0o700 })
    privateDirectory(path)
  }
  const configuration = driver.check(initial, initial.current, sourceBundle, sourceRuntime)
  const images = { php: driver.image(initial.current.images.php), nginx: driver.image(initial.current.images.nginx) }
  const model = modelFor(configuration, plan.source, images, id, volumes)
  const modelPath = join(launchFolder, 'compose.json')
  if (!fs.existsSync(modelPath)) savePlan(modelPath, launchFolder, model)
  ensure(isDeepStrictEqual(readJson(modelPath), model), 'RESTORE_LAUNCH_CONFIG_CHANGED')
  const launch = new RestoreRuntime(driver, launchFolder, { project: initial.project, operation_id: id, source: plan.source,
    images, volumes, networks: plan.networks, bundle: sourceBundle, compose_sha256: jsonHash(model) })
  launch.check = check
  const stoppedPath = join(folder, 'database-stopped.json')
  if (fs.existsSync(stoppedPath)) {
    const stopped = readJson(stoppedPath)
    launch.record('stop-intent-postgres', { id: stopped.id })
    launch.record('stopped-postgres', stopped)
  }
  launch.guard()
  if (!launch.read('stopped-postgres')) {
    if (launch.guard().postgres.State.Running) {
      ensure(driver.backup.pg('exec psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type=\'client backend\'"') === '0', 'RESTORE_DATABASE_HAS_CLIENTS')
    } else ensure(launch.read('stop-intent-postgres'), 'RESTORE_DATABASE_STOP_UNTRACKED')
    launch.stopDatabase()
    if (!fs.existsSync(stoppedPath)) savePlan(stoppedPath, folder, launch.read('stopped-postgres'))
  }
  const pg = configuration.services.postgres.environment
  const data = driver.restoreData ? driver.restoreData(dataFolder, { id, volumes, metadata, backup_path: recovery.backup_path }) : new RestoreData(driver, dataFolder,
    { id, volumes, metadata, backup_path: recovery.backup_path, utility_image: driver.backup.config.utility_image,
      database: Object.fromEntries([['name', pg.POSTGRES_DB], ['user', pg.POSTGRES_USER], ['password', pg.POSTGRES_PASSWORD]]
        .map(([key, value]) => [key, String(value).replaceAll('$$', '$')])) })
  data.check = () => { check();launch.guard() }
  const abandon = () => {
    // Only a confirmed terminal task failure permits a fresh attempt. Keep
    // all partial volumes and backup; stop just this attempt's isolated PG.
    if (data.read('failed')) {
      const staged = data.read('created-postgres')
      if (staged) {
        const item = driver.backup.inspect(staged.id)
        ensure(item.Config.Labels['pizza.data-recovery'] === id &&
          isDeepStrictEqual({ ...descriptor(item), running: false, started_at: '' }, staged) &&
          item.State.StartedAt === data.read('started-postgres')?.started_at && item.RestartCount === 0, 'RESTORE_STAGE_CHANGED')
        data.record('abandon-intent', { attempt, id })
        if (item.State.Running) driver.backup.run(['stop', item.Id], { discardOutput: true })
        ensure(!driver.backup.inspect(item.Id).State.Running, 'RESTORE_STAGE_STOP_FAILED')
      }
      data.record('abandoned', { attempt, id })
    }
  }
  if (!launch.read('restore-accepted')) {
    if (data.read('failed')) { abandon();throw new Error('RESTORE_TASK_FAILED_USE_NEW_ATTEMPT') }
    try { data.restore() } catch (error) {
      abandon()
      throw error
    }
    launch.record('restore-accepted', { attempt, volumes, backup_sha256: plan.backup_sha256 })
  }
  if (!fs.existsSync(promotionPath)) savePlan(promotionPath, folder, { attempt, id })
  if (!launch.read('started-report-worker')) queuesEmpty(driver, launch.guard().rabbitmq.Id)
  launch.launch()
  launch.health()
  const inventory = launch.guard()
  const settings = { ...driver.backup.config, postgres_container: inventory.postgres.Id, minio_container: inventory.minio.Id }
  const settingsPath = join(folder, 'backup-settings.json')
  if (!fs.existsSync(settingsPath)) savePlan(settingsPath, folder, settings)
  ensure(isDeepStrictEqual(readJson(settingsPath), settings), 'RESTORE_BACKUP_SETTINGS_CHANGED')
  const verifiedPath = join(folder, 'verified.json')
  const verified = { event: 'recovery_verified', project: initial.project,
    operation_id: identity(manifest), release_id: identity(initial.current), revision: initial.revision, backup_path: recovery.backup_path,
    volumes, containers_sha256: jsonHash(Object.fromEntries(Object.entries(inventory).filter(([name]) => name !== 'release-migration').map(([name, item]) => [name, descriptor(item)]))) }
  if (!fs.existsSync(verifiedPath)) savePlan(verifiedPath, folder, verified)
  ensure(isDeepStrictEqual(readJson(verifiedPath), verified), 'RESTORE_VERIFICATION_CHANGED')
  check()
  if (isDeepStrictEqual(readState(directory), initial)) persist(directory, initial, completed, { recovery: plan.recovery_plan, restored: verifiedPath })
  launch.cleanupRecovery()
  launch.health()
  launch.record('recovery-succeeded', { event: 'recovery_succeeded', project: completed.project, release_id: identity(completed.current), revision: completed.revision })
  return completed
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, directory, manifestPath, bundle, runtime, settingsPath, backupRoot, sourceBundle, sourceRuntime, attempt = '1', ...extra] = process.argv.slice(2)
    ensure(command === 'recover' && sourceRuntime && !extra.length && /^[1-9]\d{0,2}$/.test(attempt), 'RESTORE_ARGUMENTS')
    const state = restoreRelease(resolve(directory), validateManifest(readJson(manifestPath)), resolve(bundle), resolve(runtime), resolve(backupRoot),
      resolve(sourceBundle), resolve(sourceRuntime), new DockerCoordinator(config(readJson(settingsPath))), Number(attempt))
    console.log(JSON.stringify({ event: 'recovery_succeeded', release_id: identity(state.current) }))
  } catch (error) {
    const reason = ['RESTORE_MIGRATION_STILL_RUNNING', 'RESTORE_TASK_FAILED_USE_NEW_ATTEMPT', 'RESTORE_PREVIOUS_ATTEMPT_AMBIGUOUS',
      'RESTORE_QUEUES_NOT_EMPTY', 'RESTORE_STATE_CHANGED', 'RESTORE_TARGET_CONFIG_CHANGED', 'RESTORE_SOURCE_CONFIG_CHANGED',
      'RESTORE_PROMOTION_ALREADY_STARTED', 'RESTORE_BACKUP_CHANGED', 'RESTORE_REQUIRES_FAILED_UPGRADE'].includes(error.message) ? error.message : 'VERIFY_STATE_BACKUP_AND_JOURNAL'
    process.stderr.write('Release data recovery stopped: ' + reason + '. Preserve backup and journals; no reverse migrations are performed.\n')
    process.exitCode = 1
  }
}
