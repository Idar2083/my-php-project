import fs from 'node:fs'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { ensure } from './backup-format.mjs'

const helper = fileURLToPath(new URL('./minio-snapshot.php', import.meta.url))
const serviceCheck = fileURLToPath(new URL('./minio-service-check.php', import.meta.url))
export class DockerBackup {
  constructor(config) {
    this.config = config
    this.env = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: 'unix:///var/run/docker.sock' }
  }
  run(args, { input, output, discardOutput = false, timeout = 300000, environment = {} } = {}) {
    ensure(Object.keys(environment).every(name => ['MINIO_ROOT_USER', 'MINIO_ROOT_PASSWORD'].includes(name)))
    const helperOwner = args[0] === 'run' ? randomUUID() : null
    const helperName = helperOwner ? `pizza-backup-helper-${helperOwner}` : null
    if (helperOwner) args = [args[0], '--name', helperName, '--label', `pizza.backup-helper=${helperOwner}`, ...args.slice(1)]
    const stdin = input ? fs.openSync(input, 'r') : null
    const stdout = output ? fs.openSync(output, 'wx', 0o600) : null
    try {
      const result = spawnSync('docker', args, { env: { ...this.env, ...environment }, encoding: 'utf8',
        stdio: [stdin ?? 'ignore', stdout ?? (discardOutput ? 'ignore' : 'pipe'), 'pipe'], timeout, maxBuffer: 1024 * 1024 })
      if (result.status !== 0) {
        if (helperOwner) {
          const inspect = spawnSync('docker', ['inspect', helperName, '--format', '{{index .Config.Labels "pizza.backup-helper"}}'], { env: this.env, encoding: 'utf8', timeout: 10000 })
          if (inspect.status === 0 && inspect.stdout.trim() === helperOwner) spawnSync('docker', ['rm', '-f', helperName], { env: this.env, stdio: 'ignore', timeout: 10000 })
        }
        throw new Error(result.stderr?.includes('No space left on device') ? 'INSUFFICIENT_BACKUP_SPACE' : 'DOCKER_BACKUP_COMMAND_FAILED')
      }
      if (stdout !== null) fs.fsyncSync(stdout)
      return result.stdout?.trim() ?? ''
    } finally { if (stdin !== null) fs.closeSync(stdin); if (stdout !== null) fs.closeSync(stdout) }
  }
  inspect(id) { return JSON.parse(this.run(['inspect', id]))[0] }
  inventory(stopped = false) {
    const c = this.config
    const ids = this.run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${c.project}`]).split(/\s+/).filter(Boolean)
    ensure(ids.length > 0, 'SOURCE_PROJECT_NOT_FOUND')
    const containers = ids.map(id => this.inspect(id))
    const allowed = ['postgres', 'redis', 'rabbitmq', 'minio', 'minio-init', 'nginx', 'php', 'report-worker', 'outbox-worker', 'report-scheduler']
    ensure(containers.every(item => allowed.includes(item.Config.Labels['com.docker.compose.service'])), 'UNKNOWN_PROJECT_SERVICE')
    for (const service of ['postgres', 'minio', 'nginx', 'php', 'report-worker', 'outbox-worker', 'report-scheduler']) ensure(containers.filter(item => item.Config.Labels['com.docker.compose.service'] === service).length === 1, 'MISSING_OR_DUPLICATE_SERVICE')
    const pg = containers.find(item => item.Id === c.postgres_container)
    const minio = containers.find(item => item.Id === c.minio_container)
    ensure(pg?.Config.Labels['com.docker.compose.service'] === 'postgres' && pg.State.Running && !pg.State.Restarting, 'INVALID_POSTGRES_SOURCE')
    ensure(minio?.Config.Labels['com.docker.compose.service'] === 'minio', 'INVALID_MINIO_SOURCE')
    const writers = containers.filter(item => ['minio', 'minio-init', 'nginx', 'php', 'report-worker', 'outbox-worker', 'report-scheduler'].includes(item.Config.Labels['com.docker.compose.service']))
    if (stopped) ensure(writers.every(item => !item.State.Running && !item.State.Paused && !item.State.Restarting && item.State.ExitCode === 0 && !item.State.OOMKilled), 'WRITERS_NOT_SAFELY_STOPPED')
    const mounts = minio.Mounts.filter(mount => mount.Destination === '/data')
    ensure(mounts.length === 1 && mounts[0].Type === 'volume', 'MINIO_REQUIRES_LOCAL_VOLUME')
    const volume = JSON.parse(this.run(['volume', 'inspect', mounts[0].Name]))[0]
    ensure(volume.Driver === 'local' && (!volume.Options || Object.keys(volume.Options).length === 0), 'UNSUPPORTED_MINIO_VOLUME')
    if (stopped) {
      const users = this.run(['ps', '-aq', '--filter', `volume=${volume.Name}`]).split(/\s+/).filter(Boolean)
      ensure(users.map(id => this.inspect(id)).every(item => !item.State.Running || item.Mounts.every(mount => mount.Name !== volume.Name || !mount.RW)), 'MINIO_VOLUME_HAS_ACTIVE_WRITER')
      ensure(this.pg('exec psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND backend_type=\'client backend\'"') === '0', 'POSTGRES_HAS_ACTIVE_CLIENTS')
    }
    this.source = { pgImage: pg.Image, minioImage: minio.Image, volume: volume.Name }
    return writers.map(item => [item.Id, item.State.StartedAt, item.State.FinishedAt, item.State.Running]).sort()
  }
  pg(command, options) {
    // Credentials stay inside the existing PostgreSQL container, never in argv.
    return this.run(['exec', this.config.postgres_container, 'sh', '-ec', command], options)
  }
  version() { return this.pg('exec psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SHOW server_version"') }
  estimate() {
    const db = this.pg('exec psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT pg_database_size(current_database())"')
    const storage = this.run(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--entrypoint', 'du', '--mount', `type=volume,src=${this.source.volume},dst=/source,readonly`, this.source.pgImage, '-sk', '/source']).split(/\s+/)[0]
    ensure(/^\d+$/.test(db) && /^\d+$/.test(storage), 'CANNOT_ESTIMATE_BACKUP_SIZE')
    return BigInt(db) * 2n + BigInt(storage) * 2048n
  }
  dump(directory) {
    this.pg('exec pg_dump -Fc -U "$POSTGRES_USER" -d "$POSTGRES_DB"', { output: join(directory, 'postgres.dump') })
    this.pg('exec pg_dumpall --globals-only --no-role-passwords -U "$POSTGRES_USER"', { output: join(directory, 'globals.sql') })
  }
  toc(directory, metadata) {
    this.run(['run', '--rm', '--pull=never', '--network=none', '--read-only', '-i', '--entrypoint', 'pg_restore', metadata.postgres.image, '--list'], { input: join(directory, 'postgres.dump'), discardOutput: true })
  }
  snapshot(directory) {
    this.run(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--user=0', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE', '--cap-add=CHOWN',
      '--mount', `type=volume,src=${this.source.volume},dst=/source,readonly`, '--mount', `type=bind,src=${directory},dst=/backup`,
      '--mount', `type=bind,src=${helper},dst=/snapshot.php,readonly`, '--entrypoint', 'php', this.config.utility_image,
      '/snapshot.php', 'create', String(process.getuid()), String(process.getgid())])
  }
  preflightTools() {
    this.pg('pg_dump --version >/dev/null; pg_dumpall --globals-only --no-role-passwords -U "$POSTGRES_USER" >/dev/null; exec pg_dump --schema-only -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null')
    this.run(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--entrypoint', 'php', this.config.utility_image, '-r', 'require "/var/www/app/vendor/autoload.php"; exit(class_exists("ZipArchive") && class_exists("Aws\\\\S3\\\\S3Client") ? 0 : 1);'])
  }
  verifyRestoredMinio(volume, metadata, owner) {
    const environment = { MINIO_ROOT_USER: `restore-${randomUUID()}`, MINIO_ROOT_PASSWORD: randomUUID() + randomUUID() }
    let container
    try {
      container = this.run(['create', '--label', `pizza.backup-test=${owner}`, '--pull=never', '--network=none', '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev', '--env', 'MINIO_ROOT_USER', '--env', 'MINIO_ROOT_PASSWORD',
        '--mount', `type=volume,src=${volume},dst=/data`, metadata.minio.image, 'server', '/data'], { environment })
      this.run(['start', container])
      let ready = false
      for (let i = 0; i < 100; i++) {
        const result = spawnSync('docker', ['exec', container, 'curl', '-fsS', 'http://127.0.0.1:9000/minio/health/ready'], { env: this.env, stdio: 'ignore', timeout: 3000 })
        if (result.status === 0) { ready = true; break }
        if (!this.inspect(container).State.Running) break
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
      ensure(ready, 'RESTORED_MINIO_NOT_READY')
      const report = JSON.parse(this.run(['run', '--rm', '--pull=never', `--network=container:${container}`, '--read-only',
        '--tmpfs', '/tmp:rw,nosuid,nodev', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--env', 'MINIO_ROOT_USER', '--env', 'MINIO_ROOT_PASSWORD',
        '--mount', `type=bind,src=${serviceCheck},dst=/minio-service-check.php,readonly`, '--entrypoint', 'php',
        this.config.utility_image, '/minio-service-check.php', '/var/www/app/vendor/autoload.php'], { environment }))
      ensure(Number.isSafeInteger(report.buckets) && Number.isSafeInteger(report.versions) && Number.isSafeInteger(report.bytes) &&
        report.buckets >= 0 && report.versions >= 0 && report.bytes >= 0 && /^[a-f0-9]{64}$/.test(report.content_sha256))
      return report
    } finally {
      if (container) {
        ensure(this.inspect(container).Config.Labels['pizza.backup-test'] === owner)
        this.run(['rm', '-f', container])
      }
    }
  }
  restore(directory, metadata) {
    const owner = randomUUID(), name = `pizza-backup-restore-${owner}`
    let container, volume
    try {
      container = this.run(['create', '--label', `pizza.backup-test=${owner}`, '--pull=never', '--network=none', '--read-only',
        '--tmpfs', '/var/lib/postgresql/data:rw', '--tmpfs', '/var/run/postgresql:rw', '--tmpfs', '/tmp:rw',
        '--env', 'POSTGRES_HOST_AUTH_METHOD=trust', metadata.postgres.image])
      this.run(['start', container])
      let ready = false
      for (let i = 0; i < 100; i++) {
        const result = spawnSync('docker', ['exec', container, 'sh', '-ec', 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U postgres'], { env: this.env, stdio: 'ignore', timeout: 5000 })
        if (result.status === 0) { ready = true; break }
        // Synchronous API: no service operations run in this helper process.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
      ensure(ready, 'ISOLATED_POSTGRES_NOT_READY')
      this.run(['exec', container, 'createdb', '-U', 'postgres', 'backup_verify'])
      this.run(['exec', '-i', container, 'pg_restore', '-U', 'postgres', '-d', 'backup_verify', '--no-owner', '--no-acl', '--exit-on-error'], { input: join(directory, 'postgres.dump') })
      volume = this.run(['volume', 'create', '--label', `pizza.backup-test=${owner}`, name])
      this.run(['run', '--rm', '--pull=never', '--network=none', '--read-only', '--user=0', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE',
        '--label', `pizza.backup-test=${owner}`, '--mount', `type=volume,src=${volume},dst=/restore`,
        '--mount', `type=bind,src=${directory},dst=/backup,readonly`, '--mount', `type=bind,src=${helper},dst=/snapshot.php,readonly`,
        '--entrypoint', 'php', this.config.utility_image, '/snapshot.php', 'restore-test'])
      this.verifyRestoredMinio(volume, metadata, owner)
    } finally {
      if (container) { ensure(this.inspect(container).Config.Labels['pizza.backup-test'] === owner); this.run(['rm', '-f', '-v', container]) }
      if (volume) {
        ensure(JSON.parse(this.run(['volume', 'inspect', volume]))[0].Labels['pizza.backup-test'] === owner)
        this.run(['volume', 'rm', volume])
      }
    }
  }
}
