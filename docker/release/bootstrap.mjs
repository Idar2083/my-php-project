import fs from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { assertOperationLock, checkCandidate, identity, initialState, persist, readState } from './state.mjs'
import { ensure, readJson } from './backup-format.mjs'
import { privateDirectory, jsonHash, savePlan, backupRelease } from './coordinator.mjs'
import { applicationServices, infrastructureServices, descriptor, ReleaseRuntime } from './release-runtime.mjs'
import { continueRelease } from './release-run.mjs'
import { config } from './backup.mjs'
import { validate as validateManifest } from './manifest.mjs'
import { DockerCoordinator } from './coordinator-docker.mjs'

const services = [...infrastructureServices, 'minio-init', ...applicationServices]
const label = 'pizza.release-bootstrap'

// Preparation only: the normal coordinator still owns backup, migration,
// readiness and atomic publication of current/previous.
export class BootstrapRuntime extends ReleaseRuntime {
  candidate(item, service) {
    const config = readJson(join(this.directory, 'compose.json')).services[service]
    ensure(item.Config.Labels[label] === this.plan.operation_id && item.Image === config.image, 'BOOTSTRAP_CONTAINER_CHANGED')
    const env = Object.fromEntries(item.Config.Env.map(value => { const i = value.indexOf('=');return [value.slice(0, i), value.slice(i + 1)] }))
    for (const [key, value] of Object.entries(config.environment || {})) ensure(env[key] === String(value).replaceAll('$$', '$'), 'BOOTSTRAP_ENV_CHANGED')
    if (config.command) ensure(isDeepStrictEqual(item.Config.Cmd, config.command.map(value => String(value).replaceAll('$$', '$'))), 'BOOTSTRAP_COMMAND_CHANGED')
    if (config.entrypoint) ensure(isDeepStrictEqual(item.Config.Entrypoint, config.entrypoint.map(value => String(value).replaceAll('$$', '$'))), 'BOOTSTRAP_ENTRYPOINT_CHANGED')
    if (applicationServices.includes(service)) ensure(item.Mounts.length === 0, 'BOOTSTRAP_APPLICATION_MOUNT')
  }
  guard() {
    const inventory = this.inventory()
    for (const [name, item] of Object.entries(inventory)) {
      ensure(services.includes(name) && this.read('create-intent-' + name), 'BOOTSTRAP_UNTRACKED_CONTAINER')
      this.candidate(item, name)
      const created = this.read('created-' + name)
      if (created) ensure(isDeepStrictEqual({ ...descriptor(item), started_at: '', running: false }, { ...created, started_at: '', running: false }), 'BOOTSTRAP_CONTAINER_CHANGED')
      else ensure(item.State.Status === 'created', 'BOOTSTRAP_UNTRACKED_START')
      ensure(!item.State.OOMKilled && !item.State.Paused && !item.State.Restarting && !item.State.Dead && item.RestartCount === 0, 'BOOTSTRAP_UNSAFE_CONTAINER')
      const started = this.read('started-' + name)
      if (started) ensure(item.State.StartedAt === started.started_at && item.Id === started.id, 'BOOTSTRAP_CONTAINER_RESTARTED')
      if (!this.read('start-intent-' + name)) ensure(item.State.Status === 'created', 'BOOTSTRAP_UNTRACKED_START')
    }
    for (const name of services) if (this.read('created-' + name)) ensure(inventory[name], 'BOOTSTRAP_CONTAINER_MISSING')
    return inventory
  }
  create(service) {
    let item = this.guard()[service]
    if (this.read('created-' + service)) return item
    this.record('create-intent-' + service, { operation_id: this.plan.operation_id, service })
    if (!item) {
      this.compose(['create', '--no-build', '--pull', 'never', '--no-recreate', service])
      item = this.guard()[service]
    }
    ensure(item?.State.Status === 'created', 'BOOTSTRAP_CREATE_FAILED')
    this.record('created-' + service, descriptor(item))
    return item
  }
  initialize() {
    for (const service of services) this.create(service)
    for (const service of infrastructureServices) this.start(service)
    this.healthy(infrastructureServices)
    let item = this.guard()['minio-init']
    this.record('start-intent-minio-init', { id: item.Id })
    if (item.State.Status === 'created') this.driver.backup.run(['start', item.Id], { discardOutput: true })
    item = this.guard()['minio-init']
    const code = this.driver.backup.run(['wait', item.Id], { timeout: 60000 })
    item = this.guard()['minio-init']
    ensure(code === '0' && item.State.ExitCode === 0 && item.State.Status === 'exited', 'BOOTSTRAP_BUCKET_FAILED')
    this.record('started-minio-init', { id: item.Id, started_at: item.State.StartedAt })
    return this.guard()
  }
}

export function bootstrapModel(configuration, driver, operation) {
  ensure(isDeepStrictEqual(Object.keys(configuration.services).sort(), [...services].sort()), 'BOOTSTRAP_UNSUPPORTED_SERVICES')
  const project = configuration.name
  for (const group of ['volumes', 'networks']) for (const resource of Object.values(configuration[group] || {})) {
    ensure(!resource.external && resource.name?.startsWith(project + '_') && !resource.driver_opts && (!resource.driver || ['local', 'bridge'].includes(resource.driver)), 'BOOTSTRAP_EXTERNAL_RESOURCE')
  }
  const pg = configuration.services.postgres.environment
  for (const name of applicationServices.filter(name => name !== 'nginx')) {
    const env = configuration.services[name].environment
    ensure(env.DB_CONNECTION === 'pgsql' && env.DB_HOST === 'postgres' && String(env.DB_PORT) === '5432' &&
      env.DB_DATABASE === pg.POSTGRES_DB && env.DB_USERNAME === pg.POSTGRES_USER && env.DB_PASSWORD === pg.POSTGRES_PASSWORD, 'BOOTSTRAP_DATABASE_CONFIG')
  }
  const model = structuredClone(configuration)
  for (const [name, service] of Object.entries(model.services)) {
    delete service.depends_on
    delete service.build
    service.image = JSON.parse(driver.backup.run(['image', 'inspect', service.image]))[0].Id
    ensure(/^sha256:[a-f0-9]{64}$/.test(service.image), 'BOOTSTRAP_IMAGE_MISSING')
    service.pull_policy = 'never'
    // Infrastructure remains in place after bootstrap; retain its production
    // restart policy. Only the stopped application placeholders are disposable.
    if (applicationServices.includes(name)) service.restart = 'no'
    service.labels = { ...service.labels, [label]: operation }
  }
  return model
}

export function bootstrapRelease(directory, manifest, bundle, runtime, backupRoot, driver) {
  assertOperationLock(directory)
  privateDirectory(directory);privateDirectory(backupRoot)
  const project = driver.backup.config.project
  const initial = initialState(project)
  const configuration = driver.check(initial, manifest, bundle, runtime)
  const folder = join(directory, 'bootstrap')
  const planPath = join(folder, 'plan.json')
  const binding = { project, operation_id: identity(manifest), bundle, backup_root: fs.realpathSync(backupRoot), configuration_sha256: jsonHash(configuration) }
  if (!fs.existsSync(planPath)) {
    ensure(!fs.lstatSync(join(directory, 'state.json'), { throwIfNoEntry: false }), 'BOOTSTRAP_STATE_EXISTS')
    // Refuse adoption, including orphaned data volumes with no containers.
    const inventory = new ReleaseRuntime(driver, folder, { project }).inventory()
    ensure(Object.keys(inventory).length === 0, 'BOOTSTRAP_PROJECT_EXISTS')
    for (const kind of ['volume', 'network']) {
      const existing = driver.backup.run([kind, 'ls', '--format', '{{.Name}}']).split(/\s+/)
      for (const resource of Object.values(configuration[kind === 'volume' ? 'volumes' : 'networks'] || {})) ensure(!existing.includes(resource.name), 'BOOTSTRAP_RESOURCE_EXISTS')
      ensure(driver.backup.run([kind, 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']) === '', 'BOOTSTRAP_RESOURCE_EXISTS')
    }
    driver.images(manifest, true)
    const model = bootstrapModel(configuration, driver, identity(manifest))
    if (!fs.existsSync(folder)) fs.mkdirSync(folder, { mode: 0o700 })
    privateDirectory(folder)
    const composePath = join(folder, 'compose.json')
    if (fs.existsSync(composePath)) ensure(isDeepStrictEqual(readJson(composePath), model), 'BOOTSTRAP_CONFIG_CHANGED')
    else savePlan(composePath, folder, model)
    savePlan(planPath, folder, { ...binding, compose_sha256: jsonHash(model) })
  }
  privateDirectory(folder)
  const plan = readJson(planPath)
  const { compose_sha256, ...storedBinding } = plan
  ensure(isDeepStrictEqual(storedBinding, binding), 'BOOTSTRAP_CONFIG_CHANGED')
  ensure(jsonHash(readJson(join(folder, 'compose.json'))) === compose_sha256, 'BOOTSTRAP_CONFIG_CHANGED')
  const settingsPath = join(folder, 'backup-settings.json')
  if (!fs.existsSync(join(directory, 'state.json'))) {
    const preparation = new BootstrapRuntime(driver, folder, plan)
    const inventory = preparation.initialize()
    driver.backup.config = { ...driver.backup.config, postgres_container: inventory.postgres.Id, minio_container: inventory.minio.Id, utility_image: driver.image(manifest.images.php) }
    // No application process has run. An unexpected schema blocks adoption;
    // never delete tables or silently treat an existing database as empty.
    ensure(driver.backup.pg('exec psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname NOT IN (\'pg_catalog\',\'information_schema\') AND n.nspname !~ \'^pg_toast\' AND c.relkind IN (\'r\',\'p\',\'v\',\'m\',\'S\',\'f\')"') === '0', 'BOOTSTRAP_DATABASE_NOT_EMPTY')
    if (fs.existsSync(settingsPath)) ensure(isDeepStrictEqual(readJson(settingsPath), driver.backup.config), 'BOOTSTRAP_SETTINGS_CHANGED')
    else savePlan(settingsPath, folder, driver.backup.config)
    persist(directory, null, initial)
  } else driver.backup.config = readJson(settingsPath)
  const state = readState(directory)
  checkCandidate(state, manifest)
  ensure(!state.current || identity(state.current) === identity(manifest), 'BOOTSTRAP_ALREADY_INITIALIZED')
  if (!state.operation || ['prepared', 'images_ready', 'quiescing', 'quiesced', 'backup_ready'].includes(state.operation.phase)) {
    if (!state.current) backupRelease(directory, manifest, bundle, runtime, backupRoot, driver)
  }
  return continueRelease(directory, manifest, bundle, runtime, backupRoot, driver)
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, directory, manifestPath, bundle, runtime, project, backupRoot, ...extra] = process.argv.slice(2)
    ensure(command === 'bootstrap' && backupRoot && !extra.length)
    const settings = config({ schema_version: 1, project, postgres_container: '0'.repeat(64), minio_container: '0'.repeat(64),
      utility_image: 'sha256:' + '0'.repeat(64), reserve_bytes: 268435456 })
    const manifest = validateManifest(readJson(manifestPath))
    bootstrapRelease(resolve(directory), manifest, resolve(bundle), resolve(runtime), resolve(backupRoot), new DockerCoordinator(settings))
    console.log(JSON.stringify({ event: 'release_succeeded', release_id: identity(manifest) }))
  } catch {
    process.stderr.write('Release bootstrap failed: verify configuration, state, preparation journal and service status.\n')
    process.exitCode = 1
  }
}
