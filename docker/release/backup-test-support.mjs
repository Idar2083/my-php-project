import fs from 'node:fs'
import { join } from 'node:path'
import { identity } from './state.mjs'
import { digest, files } from './backup-format.mjs'

// Used only by synthetic state/coordinator fixtures in isolated subprocesses.
// Production preflight and explicit timeout/expiry probes retain their clocks.
export function freezeFixtureClock() {
  const now = Date.now()
  Date.now = () => now
  return now
}

// Scope leak checks to this test, including isolated restore resources created
// by a coordinator subprocess. Other test projects may share the Docker daemon.
export function scopedBackupRun(driver, owner) {
  const run = driver.run.bind(driver)
  return (args, options) => {
    const offset = ['create', 'run'].includes(args[0]) ? 1 : args[0] === 'volume' && args[1] === 'create' ? 2 : 0
    return run(offset ? [...args.slice(0, offset), '--label', `pizza.backup-test-scope=${owner}`, ...args.slice(offset)] : args, options)
  }
}

export class FakeBackup {
  config = { project: 'pizza-backup-test', reserve_bytes: 67108864 }
  source = { pgImage: 'sha256:' + 'a'.repeat(64), minioImage: 'sha256:' + 'b'.repeat(64) }
  calls = []
  inventory(stopped) { this.calls.push(stopped ? 'stopped' : 'inventory'); return ['stable-writer-state'] }
  preflightTools() {}
  estimate() { return 1n }
  version() { return '15.10' }
  dump(path) { this.calls.push('dump'); for (const name of ['postgres.dump', 'globals.sql']) fs.writeFileSync(join(path, name), 'controlled fixture ' + name) }
  toc() { this.calls.push('toc') }
  snapshot(path) { this.calls.push('snapshot'); fs.writeFileSync(join(path, 'minio.zip'), 'controlled archive fixture') }
  restore() { this.calls.push('restore-isolated') }
}
// Only state-model tests use synthetic artifacts; backup tests exercise the real
// creation path separately and the Docker integration tests use real archives.
export function stateEvidence(directory, state, next) {
  if (next.operation?.phase === 'quiescing') {
    const path = join(directory, 'test-preflight.json'), now = freezeFixtureClock()
    fs.writeFileSync(path, JSON.stringify({ schema_version: 1, project: state.project, operation_id: identity(state.operation.manifest), state_revision: state.revision,
      checked_at: new Date(now).toISOString(), expires_at: new Date(now + 900000).toISOString() }))
    return { preflight: path }
  }
  if (['backup_ready', 'migrating'].includes(next.operation?.phase)) {
    const path = join(directory, 'test-backup')
    fs.mkdirSync(path, { recursive: true })
    for (const name of files) fs.writeFileSync(join(path, name), 'fixture')
    const source = state.current ?? state.operation.manifest
    const metadata = { schema_version: 1, backup_id: 'test-backup', created_at: new Date().toISOString(), project: state.project,
      release_id: identity(source), git_sha: source.git_sha, operation_id: identity(state.operation.manifest),
      state_revision: state.revision - (next.operation.phase === 'migrating' ? 1 : 0),
      postgres: { server_version: '15.10', image: 'sha256:'+'a'.repeat(64), format: 'custom', globals: 'no-role-passwords' },
      minio: { image: 'sha256:'+'b'.repeat(64), format: 'offline-zip-v1' },
      files: files.map(name => ({ name, bytes: fs.statSync(join(path, name)).size, sha256: digest(join(path, name)) })) }
    fs.writeFileSync(join(path, 'metadata.json'), JSON.stringify(metadata))
    fs.writeFileSync(join(path, 'COMPLETE'), digest(join(path, 'metadata.json'))+'\n')
    return { backup: path }
  }
  return {}
}
