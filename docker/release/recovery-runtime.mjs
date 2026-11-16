import { isDeepStrictEqual } from 'node:util'
import { ensure } from './backup-format.mjs'
import { applicationServices, infrastructureServices, descriptor, ReleaseRuntime } from './release-runtime.mjs'
import { writerOrder } from './coordinator-docker.mjs'

// Reuse health/dependency probes and immutable receipts. Recovery starts only
// retained source containers: no Compose up, recreation, restore or migration.
export class RecoveryRuntime extends ReleaseRuntime {
  guard() {
    const services = this.inventory()
    ensure(isDeepStrictEqual(Object.keys(services).sort(), Object.keys(this.plan.source).sort()), 'RECOVERY_TOPOLOGY_CHANGED')
    for (const [name, source] of Object.entries(this.plan.source)) {
      const item = services[name], actual = descriptor(item)
      ensure(isDeepStrictEqual({ ...actual, running: false, started_at: '' }, { ...source, running: false, started_at: '' }), 'RECOVERY_CONTAINER_CHANGED')
      ensure(!item.State.Paused && !item.State.Restarting && !item.State.Dead && !item.State.OOMKilled && (item.RestartCount ?? 0) === 0, 'UNSAFE_RECOVERY_CONTAINER')
      const started = this.read('started-' + name)
      if (started) ensure(item.State.Running && actual.started_at === started.started_at && actual.id === started.id, 'RECOVERY_CONTAINER_RESTARTED')
      else if (!this.read('start-intent-' + name)) ensure(actual.started_at === source.started_at, 'RECOVERY_CONTAINER_RESTARTED')
      if (!this.read('start-intent-' + name) && !this.read('stop-intent-' + name) && name !== 'release-migration') ensure(actual.running === source.running, 'RECOVERY_CONTAINER_CHANGED')
      if (this.read('stopped-' + name)) ensure(!actual.running && item.State.ExitCode === 0, 'RECOVERY_STOP_CHANGED')
      if (name !== 'release-migration') ensure(item.State.Running || (['exited', 'created'].includes(item.State.Status) && item.State.ExitCode === 0), 'UNSAFE_RECOVERY_EXIT')
      ensure(isDeepStrictEqual(Object.keys(item.NetworkSettings.Networks).sort(), Object.keys(this.plan.networks).sort()), 'RECOVERY_NETWORK_CHANGED')
      if (item.State.Running) for (const [network, id] of Object.entries(this.plan.networks)) ensure(item.NetworkSettings.Networks[network]?.NetworkID === id, 'RECOVERY_NETWORK_CHANGED')
    }
    return services
  }
  start(service) {
    let item = this.guard()[service]
    if (this.read('started-' + service)) return item
    this.record('start-intent-' + service, { id: item.Id })
    if (!item.State.Running) {
      ensure(['exited', 'created'].includes(item.State.Status) && item.State.ExitCode === 0 && item.State.StartedAt === this.plan.source[service].started_at, 'RECOVERY_START_UNSAFE')
      this.driver.backup.run(['start', item.Id], { discardOutput: true })
    }
    item = this.driver.backup.inspect(item.Id)
    ensure(item.State.Running && !item.State.OOMKilled, 'RECOVERY_START_FAILED')
    this.record('started-' + service, { id: item.Id, started_at: item.State.StartedAt })
    this.guard()
    return item
  }
  stopWriters() {
    for (const name of writerOrder) {
      const item = this.guard()[name]
      if (!item) continue
      this.record('stop-intent-' + name, { id: item.Id })
      this.driver.stop({ id: item.Id, service: name, image: item.Image, started_at: item.State.StartedAt }, this.plan.project)
      const stopped = this.guard()[name]
      ensure(!stopped.State.Running && stopped.State.ExitCode === 0 && !stopped.State.OOMKilled, 'RECOVERY_STOP_FAILED')
      this.record('stopped-' + name, { id: item.Id, started_at: item.State.StartedAt })
    }
  }
  migrationCompleted() { ensure(this.plan.mode === 'rollback', 'MANUAL_RECOVERY_REQUIRED') }
  restoreApplication() {
    ensure(this.plan.mode === 'rollback', 'MANUAL_RECOVERY_REQUIRED')
    this.healthy(['postgres', 'redis', 'rabbitmq'])
    this.start('minio'); this.healthy(infrastructureServices)
    this.start('php'); this.healthy([...infrastructureServices, 'php']); this.dependencies()
    const ready = [...infrastructureServices, 'php']
    for (const service of ['report-worker', 'outbox-worker', 'report-scheduler', 'nginx']) {
      this.healthy(ready); this.start(service); ready.push(service); this.healthy(ready)
    }
    this.health()
  }
}
