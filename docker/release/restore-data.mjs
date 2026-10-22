import fs from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'
import { ensure, digest } from './backup-format.mjs'
import { jsonHash } from './coordinator.mjs'
import { descriptor, ReleaseRuntime } from './release-runtime.mjs'

const label = 'pizza.data-recovery'
const snapshot = fileURLToPath(new URL('./minio-snapshot.php', import.meta.url))

// Restore only to fresh volumes. An executed task is never restarted; a retry
// observes/waits for the same task. Failed tasks require a fresh explicit attempt.
export class RestoreData extends ReleaseRuntime {
  guard() { return this.check() }
  volume(name) {
    this.guard()
    const existing = this.driver.backup.run(['volume', 'ls', '--filter', 'name=^' + name + '$', '--format', '{{.Name}}'])
    ensure(!existing || this.read('volume-intent-' + name), 'RESTORE_VOLUME_ALREADY_EXISTS')
    this.record('volume-intent-' + name, { name })
    if (!existing) {
      ensure(!this.read('volume-' + name), 'RESTORE_VOLUME_MISSING')
      this.driver.backup.run(['volume', 'create', '--label', label + '=' + this.plan.id, name], { discardOutput: true })
    }
    const item = JSON.parse(this.driver.backup.run(['volume', 'inspect', name]))[0]
    ensure(item.Name === name && item.Labels?.[label] === this.plan.id && item.Driver === 'local' && !Object.keys(item.Options || {}).length, 'RESTORE_VOLUME_CHANGED')
    this.record('volume-' + name, item)
  }
  task(name, image, entrypoint, command, options = []) {
    this.guard()
    const taskName = 'pizza-restore-' + this.plan.id.slice(0, 40) + '-' + name
    const args = ['create', '--name', taskName, '--pull=never', '--label', label + '=' + this.plan.id,
      '--restart=no', ...options, '--entrypoint', entrypoint, image, ...command]
    const ids = this.driver.backup.run(['ps', '-aq', '--filter', 'name=^/' + taskName + '$']).split(/\s+/).filter(Boolean)
    ensure(ids.length <= 1 && (!ids.length || this.read('intent-' + name)), 'RESTORE_TASK_ALREADY_EXISTS')
    this.record('intent-' + name, { args_sha256: jsonHash(args) })
    if (!ids.length) {
      ensure(!this.read('created-' + name), 'RESTORE_TASK_MISSING')
      ids.push(this.driver.backup.run(args))
    }
    let item = this.driver.backup.inspect(ids[0])
    ensure(item.Config.Labels[label] === this.plan.id && item.Image === image &&
      isDeepStrictEqual(item.Config.Entrypoint, [entrypoint]) && isDeepStrictEqual(item.Config.Cmd, command), 'RESTORE_TASK_CHANGED')
    const created = this.read('created-' + name)
    const stable = { ...descriptor(item), running: false, started_at: '' }
    if (created) ensure(isDeepStrictEqual(created, stable), 'RESTORE_TASK_CHANGED')
    else { ensure(item.State.Status === 'created', 'RESTORE_TASK_UNTRACKED');this.record('created-' + name, stable) }
    ensure(!item.State.OOMKilled && !item.State.Restarting && !item.State.Paused && !item.State.Dead && item.RestartCount === 0, 'RESTORE_TASK_UNSAFE')
    const started = this.read('started-' + name)
    if (started) ensure(item.State.StartedAt === started.started_at && item.Id === started.id, 'RESTORE_TASK_RESTARTED')
    this.record('start-intent-' + name, { id: item.Id })
    if (item.State.Status === 'created') this.driver.backup.run(['start', item.Id], { discardOutput: true })
    item = this.driver.backup.inspect(item.Id)
    this.record('started-' + name, { id: item.Id, started_at: item.State.StartedAt })
    return item
  }
  complete(name, item) {
    const result = this.driver.backup.run(['wait', item.Id], { timeout: 300000 })
    item = this.driver.backup.inspect(item.Id)
    ensure(!item.State.Running && !item.State.OOMKilled && item.RestartCount === 0, 'RESTORE_TASK_AMBIGUOUS')
    ensure(result === String(item.State.ExitCode), 'RESTORE_TASK_AMBIGUOUS')
    if (result !== '0' || item.State.ExitCode !== 0) {
      this.record('failed', { task: name, id: item.Id, exit_code: item.State.ExitCode })
      throw new Error('RESTORE_TASK_FAILED_USE_NEW_ATTEMPT')
    }
    this.record('completed-' + name, descriptor(item))
  }
  restore() {
    const p = this.plan, backup = this.driver.backup
    this.guard()
    for (const name of Object.values(p.volumes)) this.volume(name)
    const env = { POSTGRES_USER: 'restore_' + p.id.slice(0, 24), POSTGRES_DB: 'postgres', POSTGRES_PASSWORD: p.database.password,
      PGUSER: 'restore_' + p.id.slice(0, 24), PGPASSWORD: p.database.password, PGHOST: '127.0.0.1',
      RECOVERY_DB_USER: p.database.user, RECOVERY_DB_NAME: p.database.name, RECOVERY_DB_PASSWORD: p.database.password }
    const envPath = join(this.directory, 'restore.env')
    const contents = Object.entries(env).map(([key, value]) => { ensure(typeof value === 'string' && value && !/[\r\n\0]/.test(value), 'RESTORE_ENV_UNSUPPORTED');return key + '=' + value + '\n' }).join('')
    if (fs.existsSync(envPath)) ensure(fs.readFileSync(envPath, 'utf8') === contents, 'RESTORE_ENV_CHANGED')
    else fs.writeFileSync(envPath, contents, { flag: 'wx', mode: 0o600, flush: true })
    // A staged database must finish its shutdown/checkpoint. Do not inherit a
    // daemon default as short as one second and then accept a forced stop.
    const pgArgs = ['--stop-timeout=30', '--network=none', '--env-file', envPath, '--mount', 'type=volume,src=' + p.volumes.postgres + ',dst=/var/lib/postgresql/data']
    if (!this.read('data-restored')) {
      const pg = this.task('postgres', p.metadata.postgres.image, 'docker-entrypoint.sh', ['postgres'], pgArgs)
      ensure(pg.State.Running, 'RESTORE_POSTGRES_STOPPED')
      let ready = false
      for (let n = 0; n < 100; n++) {
        this.guard()
        try { backup.run(['exec', pg.Id, 'sh', '-ec', 'test "$(cat /proc/1/comm)" = postgres && pg_isready -U "$POSTGRES_USER"'], { discardOutput: true });ready = true;break } catch {}
        ensure(backup.inspect(pg.Id).State.Running, 'RESTORE_POSTGRES_FAILED')
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100)
      }
      ensure(ready, 'RESTORE_POSTGRES_TIMEOUT')
      const sql = [
        'set -eu',
        'psql -X -v ON_ERROR_STOP=1 -d postgres -f /backup/globals.sql',
        'test "$(psql -X -At -d postgres -c "SELECT count(*) FROM pg_tablespace WHERE spcname NOT IN (\'pg_default\',\'pg_global\')")" = 0',
        'dropdb --if-exists --maintenance-db=template1 "$RECOVERY_DB_NAME"',
        'createdb --maintenance-db=template1 --owner "$RECOVERY_DB_USER" "$RECOVERY_DB_NAME"',
        'pg_restore --exit-on-error --dbname "$RECOVERY_DB_NAME" /backup/postgres.dump',
        "psql -X -v ON_ERROR_STOP=1 -d postgres <<'SQL'",
        '\\getenv recovery_user RECOVERY_DB_USER',
        '\\getenv recovery_password RECOVERY_DB_PASSWORD',
        'ALTER ROLE :"recovery_user" PASSWORD :\'recovery_password\';',
        'SQL',
        'test "$(psql -X -At -d postgres -c "SELECT count(*) FROM pg_roles WHERE rolcanlogin")" = 2',
        'psql -X -v ON_ERROR_STOP=1 -d postgres -c "ALTER ROLE \\"$PGUSER\\" NOLOGIN"',
      ].join('\n')
      // Globals, ownership and ACL are restored, without ignoring SQL errors.
      // Additional login roles/tablespaces are unsupported and fail in staging.
      this.complete('database', this.task('database', p.metadata.postgres.image, 'sh', ['-ec', sql], [
        '--network=container:' + pg.Id, '--env-file', envPath, '--mount', 'type=bind,src=' + p.backup_path + ',dst=/backup,readonly']))
      this.complete('files', this.task('files', p.utility_image, 'php', ['/snapshot.php', 'restore-test'], [
        '--network=none', '--read-only', '--user=0', '--cap-drop=ALL', '--cap-add=DAC_OVERRIDE',
        '--mount', 'type=volume,src=' + p.volumes.minio + ',dst=/restore', '--mount', 'type=bind,src=' + p.backup_path + ',dst=/backup,readonly',
        '--mount', 'type=bind,src=' + snapshot + ',dst=/snapshot.php,readonly']))
      this.record('files-verified', backup.verifyRestoredMinio(p.volumes.minio, p.metadata, p.id))
      this.guard()
      this.record('data-restored', { backup_sha256: digest(join(p.backup_path, 'COMPLETE')) })
    }
    const pg = backup.inspect(this.read('created-postgres').id)
    if (pg.State.Running) backup.run(['stop', pg.Id], { discardOutput: true })
    const stopped = backup.inspect(pg.Id)
    ensure(!stopped.State.Running && stopped.State.ExitCode === 0 && !stopped.State.OOMKilled, 'RESTORE_POSTGRES_STOP_FAILED')
    this.record('postgres-stopped', descriptor(stopped))
    this.guard()
    return p.volumes
  }
}
