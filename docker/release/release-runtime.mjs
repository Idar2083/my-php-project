import fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { ensure, readJson } from './backup-format.mjs'
import { jsonHash, savePlan } from './coordinator.mjs'

export const applicationServices = ['php', 'report-worker', 'outbox-worker', 'report-scheduler', 'nginx']
export const infrastructureServices = ['postgres', 'redis', 'rabbitmq', 'minio']
const migrationService = 'release-migration'
const label = 'pizza.release-operation'
const unescape = value => typeof value === 'string' ? value.replaceAll('$$', '$') : String(value)

export function descriptor(container) {
  // Docker resolves the unspecified OOM-disable flag from null to false on
  // first start. Preserve checks for true and all other HostConfig changes.
  const host = { ...container.HostConfig, OomKillDisable: container.HostConfig?.OomKillDisable ?? false }
  return { id: container.Id, image: container.Image, configuration: jsonHash([container.Config, host, container.Mounts]),
    started_at: container.State.StartedAt, running: container.State.Running }
}

export class ReleaseRuntime {
  constructor(driver, directory, plan) { this.driver = driver; this.directory = directory; this.plan = plan }
  read(name) { const path = join(this.directory, name + '.json'); return fs.lstatSync(path, { throwIfNoEntry: false }) === undefined ? null : readJson(path) }
  record(name, data) {
    const existing = this.read(name)
    if (existing) ensure(isDeepStrictEqual(existing, data), 'RELEASE_JOURNAL_CONFLICT')
    else savePlan(join(this.directory, name + '.json'), this.directory, data)
    return data
  }
  compose(args) {
    ensure(jsonHash(readJson(join(this.directory, 'compose.json'))) === this.plan.compose_sha256, 'RELEASE_CONFIG_CHANGED')
    return this.driver.backup.run(['compose', '--project-name', this.plan.project, '--project-directory', this.plan.bundle,
      '--env-file', '/dev/null', '-f', join(this.directory, 'compose.json'), ...args], { discardOutput: true })
  }
  inventory() {
    const ids = this.driver.backup.run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${this.plan.project}`]).split(/\s+/).filter(Boolean)
    const services = {}
    for (const id of ids) {
      const item = this.driver.backup.inspect(id), labels = item.Config.Labels
      const name = labels['com.docker.compose.service']
      ensure(labels['com.docker.compose.project'] === this.plan.project &&
        [...applicationServices, ...infrastructureServices, 'minio-init', migrationService].includes(name) && !services[name], 'RELEASE_TOPOLOGY_CHANGED')
      services[name] = item
    }
    return services
  }
  candidate(item, service) {
    const config = readJson(join(this.directory, 'compose.json')).services[service]
    ensure(item.Config.Labels[label] === this.plan.operation_id && item.Image === this.plan.images[service === 'nginx' ? 'nginx' : 'php'], 'RELEASE_CONTAINER_CHANGED')
    ensure((item.Mounts || []).length === 0, 'UNEXPECTED_APPLICATION_MOUNT')
    const env = Object.fromEntries((item.Config.Env || []).map(value => { const index = value.indexOf('='); return [value.slice(0, index), value.slice(index + 1)] }))
    for (const [key, value] of Object.entries(config.environment || {})) ensure(env[key] === unescape(value), 'RELEASE_ENVIRONMENT_CHANGED')
    if (config.command) ensure(isDeepStrictEqual(item.Config.Cmd, config.command.map(unescape)), 'RELEASE_COMMAND_CHANGED')
    if (config.entrypoint) ensure(isDeepStrictEqual(item.Config.Entrypoint, config.entrypoint.map(unescape)), 'RELEASE_ENTRYPOINT_CHANGED')
    if (service !== migrationService) ensure(item.Config.Healthcheck?.Test?.[0] !== 'NONE' && item.Config.Healthcheck?.Test?.length, 'MISSING_RELEASE_HEALTHCHECK')
  }
  guard() {
    const services = this.inventory()
    for (const name of [...Object.keys(this.plan.source), migrationService]) {
      const item = services[name], created = this.read('created-' + name), intent = this.read('create-intent-' + name)
      if (name === migrationService && !item && this.committed && this.read('cleanup-intent')) continue
      if (created) {
        ensure(item && isDeepStrictEqual({ ...descriptor(item), started_at: '', running: false }, { ...created, started_at: '', running: false }), 'RELEASE_CONTAINER_CHANGED')
        if (applicationServices.includes(name) || name === migrationService) this.candidate(item, name)
      } else if (intent) {
        if (item && item.Id !== this.plan.source[name]?.id) {
          this.candidate(item, name)
          ensure(item.State.Status === 'created', 'UNTRACKED_CONTAINER_START')
        } else if (item) ensure(isDeepStrictEqual(descriptor(item), this.plan.source[name]), 'SOURCE_CONTAINER_CHANGED')
      } else if (this.plan.source[name]) ensure(item && isDeepStrictEqual(descriptor(item), this.plan.source[name]), 'SOURCE_CONTAINER_CHANGED')
      else ensure(!item, 'UNEXPECTED_MIGRATION_CONTAINER')
      if (!item) continue
      ensure(!item.State.Paused && !item.State.Restarting && !item.State.Dead && !item.State.OOMKilled && (item.RestartCount ?? 0) === 0, 'UNSAFE_RELEASE_CONTAINER')
      const migrationStarted = name === migrationService && this.read('migration-started')
      if (migrationStarted) ensure(item.Id === migrationStarted.id && item.State.StartedAt === migrationStarted.started_at, 'MIGRATION_CONTAINER_RESTARTED')
      const started = this.read('started-' + name)
      if (started) ensure(item.State.Running && item.State.StartedAt === started.started_at && item.Id === started.id, 'RELEASE_CONTAINER_RESTARTED')
      if (created && !this.read('start-intent-' + name)) ensure(item.State.Status === 'created' || (name === 'minio' && isDeepStrictEqual(descriptor(item), this.plan.source.minio)), 'UNTRACKED_CONTAINER_START')
      if (this.read('start-intent-' + name) && name !== migrationService && item.State.Status !== 'created' &&
          !(name === 'minio' && item.State.StartedAt === this.plan.source.minio.started_at && !this.read('started-minio'))) ensure(item.State.Running, 'RELEASE_CONTAINER_EXITED')
      ensure(isDeepStrictEqual(Object.keys(item.NetworkSettings.Networks).sort(), Object.keys(this.plan.networks).sort()), 'RELEASE_NETWORK_CHANGED')
      if (item.State.Running) {
        for (const [network, expected] of Object.entries(this.plan.networks)) ensure(item.NetworkSettings.Networks[network]?.NetworkID === expected, 'RELEASE_NETWORK_CHANGED')
      }
    }
    return services
  }
  create(service) {
    let services = this.guard()
    if (this.read('created-' + service)) return services[service]
    this.record('create-intent-' + service, { operation_id: this.plan.operation_id, service })
    let item = services[service]
    if (!item || item.Config.Labels[label] !== this.plan.operation_id) {
      this.compose(['create', '--no-build', '--pull', 'never', service])
      services = this.guard(); item = services[service]
    }
    ensure(item?.State.Status === 'created', 'RELEASE_CREATE_FAILED')
    this.candidate(item, service)
    this.record('created-' + service, descriptor(item))
    return item
  }
  start(service) {
    let item = this.guard()[service]
    if (this.read('started-' + service)) return item
    if (service === 'minio' && !this.read('created-' + service)) this.record('created-' + service, descriptor(item))
    this.record('start-intent-' + service, { id: item.Id })
    if (item.State.Status === 'created' || (service === 'minio' && item.State.Status === 'exited' && item.State.StartedAt === this.plan.source.minio.started_at)) {
      ensure(item.State.ExitCode === 0, 'RELEASE_START_UNSAFE')
      this.driver.backup.run(['start', item.Id], { discardOutput: true })
    }
    item = this.driver.backup.inspect(item.Id)
    ensure(item.State.Running, 'RELEASE_START_FAILED')
    this.record('started-' + service, { id: item.Id, started_at: item.State.StartedAt })
    return item
  }
  healthy(names) {
    const deadline = Date.now() + 180000
    while (true) {
      const services = this.guard()
      let ready = true
      for (const name of names) {
        const item = services[name]
        ensure(item?.State.Running && item.State.Health && item.State.Health.Status !== 'unhealthy', 'RELEASE_SERVICE_UNHEALTHY')
        ready &&= item.State.Health.Status === 'healthy'
      }
      if (ready) {
        for (const name of names) if (this.read('start-intent-' + name)) {
          const item = services[name]; this.record('started-' + name, { id: item.Id, started_at: item.State.StartedAt })
        }
        return
      }
      ensure(Date.now() < deadline, 'RELEASE_HEALTH_TIMEOUT')
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 500)
    }
  }
  migrate() {
    this.healthy(['postgres', 'redis', 'rabbitmq'])
    let item = this.create(migrationService)
    this.record('start-intent-' + migrationService, { id: item.Id })
    if (item.State.Status === 'created') this.driver.backup.run(['start', item.Id], { discardOutput: true })
    item = this.guard()[migrationService]
    ensure(['running', 'exited'].includes(item.State.Status), 'RELEASE_MIGRATION_NOT_STARTED')
    this.record('migration-started', { id: item.Id, started_at: item.State.StartedAt })
    const result = this.driver.backup.run(['wait', item.Id], { timeout: 300000 })
    item = this.guard()[migrationService]
    ensure(result === '0' && item.State.Status === 'exited' && item.State.ExitCode === 0, 'RELEASE_MIGRATION_FAILED')
    this.record('migration-completed', descriptor(item))
  }
  migrationCompleted() {
    const item = this.guard()[migrationService]
    if (!item && this.committed && this.read('cleanup-intent') && this.read('migration-completed')) return
    ensure(this.read('migration-completed') && isDeepStrictEqual(descriptor(item), this.read('migration-completed')) && item.State.ExitCode === 0 && item.State.Status === 'exited', 'RELEASE_MIGRATION_UNCONFIRMED')
  }
  startApplication() {
    this.migrationCompleted()
    this.start('minio'); this.healthy(infrastructureServices)
    this.create('php'); this.start('php'); this.healthy([...infrastructureServices, 'php'])
    this.driver.backup.run(['exec', this.guard().php.Id, 'php', 'artisan', 'migrate:status', '--no-ansi'], { discardOutput: true })
    this.dependencies()
    const ready = [...infrastructureServices, 'php']
    for (const service of ['report-worker', 'outbox-worker', 'report-scheduler']) {
      this.healthy(ready)
      this.create(service); this.start(service); ready.push(service); this.healthy(ready)
    }
    this.healthy([...infrastructureServices, 'php', 'report-worker', 'outbox-worker', 'report-scheduler'])
    this.create('nginx'); this.start('nginx'); this.health()
  }
  dependencies() {
    this.healthy([...infrastructureServices, 'php'])
    this.driver.backup.run(['exec', '-i', this.guard().php.Id, 'php', '-f', '/dev/stdin', '--', '/var/www/app'], {
      input: fileURLToPath(new URL('./release-readiness.php', import.meta.url)), discardOutput: true, timeout: 30000,
    })
  }
  cleanup() {
    ensure(this.committed, 'RELEASE_NOT_COMMITTED')
    const item = this.guard()[migrationService]
    const completed = this.read('migration-completed')
    ensure(completed, 'RELEASE_MIGRATION_UNCONFIRMED')
    this.record('cleanup-intent', { id: completed.id })
    if (item) {
      ensure(item.Id === completed.id && item.State.Status === 'exited' && item.State.ExitCode === 0, 'RELEASE_CLEANUP_UNSAFE')
      this.driver.backup.run(['rm', item.Id], { discardOutput: true })
    }
  }
  health() {
    this.migrationCompleted()
    this.healthy([...infrastructureServices, ...applicationServices])
    this.dependencies()
    const nginx = this.guard().nginx
    const body = this.driver.backup.run(['exec', nginx.Id, 'wget', '-q', '-O', '-', '--header=Accept: application/json', 'http://127.0.0.1/api/products'])
    ensure(Array.isArray(JSON.parse(body).data), 'RELEASE_API_UNHEALTHY')
    this.guard()
  }
}
