import fs from 'node:fs'
import { FakeCoordinator } from './coordinator-test-support.mjs'

export class FakeReleaseDriver extends FakeCoordinator {
  constructor(path) {
    super(path)
    const fixtures = this.read()
    this.backup.config = { schema_version: 1, project: 'pizza-backup-test', reserve_bytes: 67108864,
      postgres_container: fixtures.containers.postgres.Id, minio_container: fixtures.containers.minio.Id, utility_image: 'sha256:' + 'e'.repeat(64) }
    this.backup.run = args => this.run(args)
    this.backup.inspect = id => {
      const item = Object.values(this.read().containers).find(item => item.Id === id)
      if (!item) throw new Error('container missing')
      return structuredClone(item)
    }
  }
  hit(name) {
    super.hit(name)
    if (this.read().kill === name) process.kill(process.pid, 'SIGKILL')
  }
  check() {
    this.hit('check')
    const config = structuredClone(this.read().compose)
    if (this.read().configuration) config.services.php.environment.APP_URL = 'changed'
    return config
  }
  image(ref) { return 'sha256:' + (ref.includes('/nginx@') ? 'c' : 'b').repeat(64) }
  stop(writer) {
    const fixture = this.read()
    if (fixture.writers.find(item => item.service === writer.service)?.id !== writer.id) {
      this.hit('stop:' + writer.service)
      const value = this.read(), item = value.containers[writer.service]
      if (item.Id !== writer.id || item.State.StartedAt !== writer.started_at) throw new Error('changed')
      Object.assign(item.State, { Running: false, Status: 'exited' })
      this.write(value);this.hit('after-stop:' + writer.service)
      return
    }
    super.stop(writer)
    const value = this.read(), item = value.containers[writer.service]
    Object.assign(item.State, { Running: false, Status: 'exited' })
    this.write(value);this.hit('after-stop:' + writer.service)
  }
  run(args) {
    let value = this.read()
    if (args[0] === 'ps') return Object.values(value.containers).map(item => item.Id).join('\n')
    if (args[0] === 'compose') {
      const name = args.at(-1), model = JSON.parse(fs.readFileSync(args[args.indexOf('-f') + 1], 'utf8'))
      this.hit('create:' + name); value = this.read()
      const config = model.services[name]
      const item = container(name, config, ++value.counter)
      item.Image = config.image
      item.Config.Labels = { ...item.Config.Labels, ...config.labels }
      Object.assign(item.State, { Status: 'created', Running: false, StartedAt: 'zero' })
      value.containers[name] = item;this.write(value)
      this.hit('after-create:' + name)
      return ''
    }
    const name = Object.keys(value.containers).find(name => value.containers[name].Id === (args[1] === '-i' ? args[2] : args[1]))
    if (args[0] === 'start') {
      this.hit('start:' + name); value = this.read()
      const item = value.containers[name]
      Object.assign(item.State, { Status: 'running', Running: true, StartedAt: 'started-' + item.Id })
      item.State.Health.Status = value.unhealthy === name ? 'unhealthy' : 'healthy'
      this.write(value);this.hit('after-start:' + name)
      return ''
    }
    if (args[0] === 'wait') {
      if (value.containers[name].State.Status === 'exited') return String(value.containers[name].State.ExitCode)
      this.hit('migration');value = this.read()
      Object.assign(value.containers[name].State, { Status: 'exited', Running: false, ExitCode: value.migration_exit ?? 0 })
      this.write(value);this.hit('after-migration')
      return String(value.migration_exit ?? 0)
    }
    if (args[0] === 'exec') {
      if (args.includes('-i')) { this.hit('dependencies');return '' }
      if (args.includes('wget')) { this.hit('api');return JSON.stringify({ data: [] }) }
      this.hit('schema-status');return ''
    }
    if (args[0] === 'rm') {
      this.hit('cleanup');value = this.read();delete value.containers[name];this.write(value);this.hit('after-cleanup');return ''
    }
    throw new Error('Unexpected fake Docker command')
  }
}

export function container(name, config = {}, index = 1) {
  const env = Object.entries(config.environment || {}).map(([key, value]) => `${key}=${String(value).replaceAll('$$', '$')}`)
  if (name === 'postgres') env.push('POSTGRES_DB=pizza', 'POSTGRES_USER=pizza', 'POSTGRES_PASSWORD=' + String(config.environment?.DB_PASSWORD || 'public-fixture').replaceAll('$$', '$'))
  return { Id: index.toString(16).padStart(64, '0'), Image: 'sha256:' + 'e'.repeat(64), RestartCount: 0,
    Config: { Labels: { 'com.docker.compose.project': 'pizza-backup-test', 'com.docker.compose.service': name },
      Env: env, Cmd: config.command || ['default'], Entrypoint: config.entrypoint || ['default'], Healthcheck: { Test: config.healthcheck?.test || ['CMD', 'true'] } },
    HostConfig: {}, Mounts: [], NetworkSettings: { Networks: { 'pizza-backup-test_default': { NetworkID: 'fixture-network' } } },
    State: { Running: true, Status: 'running', StartedAt: 'initial', ExitCode: 0, OOMKilled: false, Paused: false, Restarting: false, Dead: false, Health: { Status: 'healthy' } } }
}
