import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { advance, assertOperationLock, assertNoRecovery, checkBackupCandidate, checkCandidate, identity, persist, readState } from './state.mjs'
import { config, verifyBackup } from './backup.mjs'
import { ensure, readJson } from './backup-format.mjs'
import { backupRelease, configurationHash, jsonHash, privateDirectory, savePlan } from './coordinator.mjs'
import { validate as validateManifest } from './manifest.mjs'
import { DockerCoordinator } from './coordinator-docker.mjs'
import { applicationServices, infrastructureServices, descriptor, ReleaseRuntime } from './release-runtime.mjs'

const offsets = { backup_ready: 0, migrating: 1, migrated: 2, starting: 3, verified: 4 }

export function checkDatabase(configuration, inventory) {
  const postgres = Object.fromEntries(inventory.postgres.Config.Env.map(value => { const index = value.indexOf('=');return [value.slice(0, index), value.slice(index + 1)] }))
  for (const service of applicationServices.filter(name => name !== 'nginx')) {
    const env = Object.fromEntries(Object.entries(configuration.services[service].environment).map(([key, value]) => [key, String(value).replaceAll('$$', '$')]))
    ensure(env.DB_CONNECTION === 'pgsql' && env.DB_HOST === 'postgres' && String(env.DB_PORT) === '5432' &&
      env.DB_DATABASE === postgres.POSTGRES_DB && env.DB_USERNAME === postgres.POSTGRES_USER && env.DB_PASSWORD === postgres.POSTGRES_PASSWORD, 'RELEASE_DATABASE_MISMATCH')
    const current = Object.fromEntries(inventory[service].Config.Env.map(value => { const index = value.indexOf('=');return [value.slice(0, index), value.slice(index + 1)] }))
    for (const key of ['DB_CONNECTION', 'DB_HOST', 'DB_PORT', 'DB_DATABASE', 'DB_USERNAME', 'DB_PASSWORD']) ensure(current[key] === env[key], 'SOURCE_DATABASE_MISMATCH')
  }
}

export function deploymentModel(configuration, source, images, operation) {
  const model = structuredClone(configuration)
  for (const [name, service] of Object.entries(model.services)) {
    delete service.depends_on
    delete service.build
    service.pull_policy = 'never'
    if (applicationServices.includes(name)) {
      service.image = images[name === 'nginx' ? 'nginx' : 'php']
      service.labels = { ...service.labels, 'pizza.release-operation': operation }
      ensure(service.healthcheck && !service.healthcheck.disable && service.healthcheck.test?.[0] !== 'NONE', 'MISSING_RELEASE_HEALTHCHECK')
    } else if (source[name]) service.image = source[name].image
  }
  model.services['release-migration'] = { ...structuredClone(model.services.php),
    // Use a shared lock that exists before the first database migration;
    // preserve the application's cache store (including JWT blacklist data).
    environment: { ...model.services.php.environment, CACHE_STORE: 'redis' },
    container_name: 'pizza-release-migrate-' + jsonHash([configuration.name, operation]), entrypoint: ['php'],
    command: ['artisan', 'migrate', '--force', '--isolated=75', '--no-ansi'], restart: 'no', healthcheck: { disable: true } }
  return model
}

export function continueRelease(directory, manifest, bundle, runtime, backupRoot, driver) {
  assertOperationLock(directory)
  privateDirectory(directory); privateDirectory(backupRoot)
  let state = readState(directory)
  assertNoRecovery(directory, manifest)
  checkCandidate(state, manifest)
  const committed = !state.operation && state.current && identity(state.current) === identity(manifest)
  ensure(committed || (state.operation && offsets[state.operation.phase] !== undefined), 'RELEASE_REQUIRES_BACKUP_READY')
  const revision = committed ? state.revision - 5 : state.revision - offsets[state.operation.phase]
  const folder = join(directory, `launch-${identity(manifest)}-${revision}`)
  const planFile = join(folder, 'plan.json')
  const configuration = driver.check(state, manifest, bundle, runtime)
  driver.images(manifest)
  if (!fs.existsSync(planFile)) {
    ensure(state.operation?.phase === 'backup_ready', 'RELEASE_PLAN_MISSING')
    const verified = backupRelease(directory, manifest, bundle, runtime, backupRoot, driver)
    ensure(verified.state.operation?.phase === 'backup_ready', 'RELEASE_REQUIRES_BACKUP_READY')
    const inventory = new ReleaseRuntime(driver, folder, { project: state.project }).inventory()
    ensure(!inventory['release-migration'], 'UNEXPECTED_MIGRATION_CONTAINER')
    for (const name of [...applicationServices, ...infrastructureServices]) ensure(inventory[name], 'RELEASE_SERVICE_MISSING')
    const source = Object.fromEntries(Object.entries(inventory).map(([name, item]) => [name, descriptor(item)]))
    const images = { php: driver.image(manifest.images.php), nginx: driver.image(manifest.images.nginx) }
    const networks = Object.fromEntries(Object.entries(inventory.postgres.NetworkSettings.Networks).map(([name, value]) => [name, value.NetworkID]))
    ensure(Object.keys(networks).length > 0 && Object.values(networks).every(Boolean), 'RELEASE_NETWORK_MISSING')
    checkDatabase(configuration, inventory)
    const model = deploymentModel(configuration, source, images, identity(manifest))
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 })
    privateDirectory(folder)
    if (fs.existsSync(join(folder, 'compose.json'))) ensure(isDeepStrictEqual(readJson(join(folder, 'compose.json')), model), 'RELEASE_CONFIG_CHANGED')
    else savePlan(join(folder, 'compose.json'), folder, model)
    savePlan(planFile, folder, { schema_version: 1, project: state.project, operation_id: identity(manifest), initial_state: state,
      backup_path: verified.backupPath, source, images, networks, bundle,
      configuration_sha256: configurationHash(configuration, driver.backup.config, backupRoot), compose_sha256: jsonHash(model) })
  }
  privateDirectory(folder)
  const plan = readJson(planFile)
  ensure(plan.schema_version === 1 && plan.project === state.project && plan.operation_id === identity(manifest) &&
    plan.initial_state.operation.phase === 'backup_ready' && plan.initial_state.revision === revision &&
    (committed ? isDeepStrictEqual(state.previous, plan.initial_state.current) : (isDeepStrictEqual(state.current, plan.initial_state.current) && isDeepStrictEqual(state.previous, plan.initial_state.previous))), 'RELEASE_PLAN_CONFLICT')
  checkBackupCandidate(plan.initial_state, manifest, verifyBackup(plan.backup_path, driver.backup))
  const launch = new ReleaseRuntime(driver, folder, plan)
  launch.committed = committed
  const guard = launch.guard.bind(launch)
  launch.guard = () => {
    ensure(configurationHash(driver.check(state, manifest, bundle, runtime), driver.backup.config, backupRoot) === plan.configuration_sha256, 'RELEASE_CONFIG_CHANGED')
    ensure(jsonHash(readJson(join(folder, 'compose.json'))) === plan.compose_sha256, 'RELEASE_CONFIG_CHANGED')
    return guard()
  }
  const transition = phase => {
    launch.guard()
    const next = advance(state, manifest, phase)
    persist(directory, state, next, phase === 'migrating' ? { backup: plan.backup_path } : {})
    state = next
  }
  launch.guard()
  if (!committed) {
    if (state.operation.phase === 'backup_ready') transition('migrating')
    if (state.operation.phase === 'migrating') { launch.migrate(); transition('migrated') }
    if (state.operation.phase === 'migrated') { launch.migrationCompleted(); transition('starting') }
    if (state.operation.phase === 'starting') { launch.startApplication(); transition('verified') }
    launch.health()
    transition('committed')
    launch.committed = true
  } else launch.health()
  launch.cleanup()
  launch.record('release-succeeded', { event: 'release_succeeded', project: state.project, release_id: identity(manifest), revision: state.revision })
  return state
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, directory, manifestPath, bundle, runtime, settingsPath, backupRoot, ...extra] = process.argv.slice(2)
    ensure(command === 'continue' && backupRoot && !extra.length)
    const manifest = validateManifest(readJson(manifestPath))
    const driver = new DockerCoordinator(config(readJson(settingsPath)))
    continueRelease(resolve(directory), manifest, resolve(bundle), resolve(runtime), resolve(backupRoot), driver)
    console.log(JSON.stringify({ event: 'release_succeeded', release_id: identity(manifest) }))
  } catch {
    process.stderr.write('Release continuation failed: verify phase, operation journal, configuration, images and service status.\n')
    process.exitCode = 1
  }
}
