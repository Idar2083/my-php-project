import fs from 'node:fs'
import { FakeBackup, freezeFixtureClock } from './backup-test-support.mjs'
import { ensure } from './backup-format.mjs'

// State is persisted only in each test's private temporary directory, so a new
// process can exercise a retry after an interrupted stop without live services.
export class FakeCoordinator {
  constructor(path) {
    this.path = path
    // Synthetic release subprocesses must not depend on host clock corrections.
    // Explicit health-timeout probes replace Date.now after constructing us.
    freezeFixtureClock()
    const artifacts = new FakeBackup()
    this.backup = {
      source: artifacts.source,
      version: () => { this.hit('version'); return artifacts.version() },
      dump: path => { this.hit('dump'); artifacts.dump(path) },
      toc: () => this.hit('toc'),
      snapshot: path => { this.hit('archive'); artifacts.snapshot(path) },
      restore: () => this.hit('restore'),
      config: { project: 'pizza-backup-test', reserve_bytes: 67108864 },
      inventory: stopped => {
        this.hit(stopped ? 'stopped-inventory' : 'inventory')
        const writers = this.read().writers
        if (stopped) ensure(writers.every(item => !item.running && item.exit_code === 0 && !item.oom))
        return writers.map(item => [item.id, item.started_at, item.running])
      },
      preflightTools: () => this.hit('tools'),
      estimate: () => { this.hit('estimate'); return this.read().space_failure ? 2n ** 100n : 1n },
    }
  }
  read() { return JSON.parse(fs.readFileSync(this.path, 'utf8')) }
  write(value) { fs.writeFileSync(this.path, JSON.stringify(value)) }
  hit(name) {
    const value = this.read()
    value.calls.push(name)
    this.write(value)
    if (value.fail === name) throw new Error('controlled-secret-canary')
  }
  check() { this.hit('check'); return { runtime_secret: 'controlled-secret-canary', version: this.read().configuration ?? 1 } }
  images(manifest, pull = false) {
    for (const service of ['php', 'nginx']) {
      if (pull) this.hit(`pull:${service}`)
      this.hit(`image:${service}`)
    }
  }
  snapshot() {
    this.hit('snapshot')
    const value = this.read()
    for (const item of value.writers) ensure(item.exit_code === 0 && !item.oom)
    return value.writers.map(({ exit_code, oom, running, ...writer }) => writer)
  }
  stop(writer) {
    this.hit(`stop:${writer.service}`)
    const value = this.read()
    const item = value.writers.find(item => item.id === writer.id)
    if (item.running) value.stops.push(writer.service)
    item.running = false
    if (value.bad_exit === writer.service) item.exit_code = 137
    if (value.oom === writer.service) item.oom = true
    this.write(value)
    ensure(item.exit_code === 0 && !item.oom)
  }
  quiesced() {
    this.backup.inventory(true)
    ensure(this.read().writers.every(writer => !writer.running))
  }
}
