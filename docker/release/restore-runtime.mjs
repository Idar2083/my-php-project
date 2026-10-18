import { isDeepStrictEqual } from 'node:util'
import { ensure, readJson } from './backup-format.mjs'
import { join } from 'node:path'
import { applicationServices, descriptor, ReleaseRuntime } from './release-runtime.mjs'

// Same create/start/health/dependency protocol as ordinary releases, with the
// failed installation retained as the source and restored data as the target.
export class RestoreRuntime extends ReleaseRuntime {
  candidate(item, name) {
    const config = readJson(join(this.directory, 'compose.json')).services[name]
    ensure(item.Config.Labels['pizza.release-operation'] === this.plan.operation_id && item.Image === config.image, 'RESTORE_CANDIDATE_CHANGED')
    const env = Object.fromEntries(item.Config.Env.map(value => { const i = value.indexOf('=');return [value.slice(0, i), value.slice(i + 1)] }))
    for (const [key, value] of Object.entries(config.environment || {})) ensure(env[key] === String(value).replaceAll('$$', '$'), 'RESTORE_ENVIRONMENT_CHANGED')
    for (const [field, actual] of [['command', item.Config.Cmd], ['entrypoint', item.Config.Entrypoint]]) {
      if (config[field]) ensure(isDeepStrictEqual(actual, config[field].map(value => String(value).replaceAll('$$', '$'))), 'RESTORE_COMMAND_CHANGED')
    }
    if (applicationServices.includes(name)) ensure(item.Mounts.length === 0, 'RESTORE_APPLICATION_MOUNT')
    if (['postgres', 'minio'].includes(name)) {
      const destination = name === 'postgres' ? '/var/lib/postgresql/data' : '/data'
      const mounts = item.Mounts.filter(m => m.Destination === destination)
      ensure(mounts.length === 1 && mounts[0].Type === 'volume' && mounts[0].Name === this.plan.volumes[name], 'RESTORE_DATA_VOLUME_CHANGED')
    }
  }
  guard() {
    this.check()
    const inventory = this.inventory()
    ensure(Object.keys(inventory).every(name => this.plan.source[name]), 'RESTORE_TOPOLOGY_CHANGED')
    for (const [name, original] of Object.entries(this.plan.source)) {
      const item = inventory[name], intent = this.read('create-intent-' + name), created = this.read('created-' + name)
      // A crash between Compose removing the old container and creating its
      // replacement is resumable only for the journaled service.
      if (!item) {
        if (name === 'release-migration' && this.read('cleanup-intent')) continue
        ensure(intent && !created, 'RESTORE_CONTAINER_MISSING');continue
      }
      const actual = descriptor(item)
      ensure(!item.State.Paused && !item.State.OOMKilled && !item.State.Dead && !item.State.Restarting && item.RestartCount === 0, 'RESTORE_UNSAFE_CONTAINER')
      if (created || (intent && item.Id !== original.id)) {
        this.candidate(item, name)
        if (created) ensure(isDeepStrictEqual({ ...actual, running: false, started_at: '' }, { ...created, running: false, started_at: '' }), 'RESTORE_CONTAINER_CHANGED')
        else ensure(item.State.Status === 'created', 'RESTORE_UNTRACKED_START')
      } else {
        ensure(isDeepStrictEqual({ ...actual, running: false }, { ...original, running: false }), 'RESTORE_SOURCE_CHANGED')
        if (this.read('stop-intent-' + name)) ensure(!actual.running || !this.read('stopped-' + name), 'RESTORE_SOURCE_RESTARTED')
        else ensure(actual.running === original.running, 'RESTORE_SOURCE_CHANGED')
      }
      const started = this.read('started-' + name)
      if (started) ensure(actual.running && actual.id === started.id && actual.started_at === started.started_at, 'RESTORE_CONTAINER_RESTARTED')
      if (created && !this.read('start-intent-' + name)) ensure(item.State.Status === 'created', 'RESTORE_UNTRACKED_START')
      if (name === 'release-migration') ensure(!item.State.Running, 'RESTORE_MIGRATION_STILL_RUNNING')
      if (name !== 'release-migration') ensure(item.State.Running || (['created', 'exited'].includes(item.State.Status) && item.State.ExitCode === 0), 'RESTORE_UNSAFE_EXIT')
      ensure(isDeepStrictEqual(Object.keys(item.NetworkSettings.Networks).sort(), Object.keys(this.plan.networks).sort()), 'RESTORE_NETWORK_CHANGED')
      if (item.State.Running) for (const [network, id] of Object.entries(this.plan.networks)) ensure(item.NetworkSettings.Networks[network]?.NetworkID === id, 'RESTORE_NETWORK_CHANGED')
    }
    return inventory
  }
  stopDatabase() {
    const item = this.guard().postgres
    this.record('stop-intent-postgres', { id: item.Id })
    if (item.State.Running) this.driver.backup.run(['stop', item.Id], { discardOutput: true })
    const stopped = this.guard().postgres
    ensure(!stopped.State.Running && stopped.State.ExitCode === 0, 'RESTORE_DATABASE_STOP_FAILED')
    this.record('stopped-postgres', descriptor(stopped))
  }
  migrationCompleted() {
    ensure(this.read('restore-accepted'), 'RESTORE_DATA_NOT_CONFIRMED')
  }
  launch() {
    this.migrationCompleted()
    this.create('postgres');this.start('postgres');this.healthy(['postgres', 'redis', 'rabbitmq'])
    this.create('minio')
    this.startApplication()
  }
  cleanupRecovery() {
    const item = this.guard()['release-migration']
    this.record('cleanup-intent', { id: this.plan.source['release-migration']?.id ?? null })
    if (item) {
      ensure(!item.State.Running, 'RESTORE_MIGRATION_STILL_RUNNING')
      this.driver.backup.run(['rm', item.Id], { discardOutput: true })
    }
  }
}
