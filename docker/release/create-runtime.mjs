import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

// Operator preparation only. Never invoked by CI or the release coordinator.
// No secrets in arguments, shell environment or stdout. This first-install
// configuration deliberately supports only private access via an SSH tunnel.
export function createRuntime(directory, port = '8080') {
  if (!/^[1-9][0-9]{0,4}$/.test(port) || +port > 65535) throw new Error('INVALID_PORT')
  const stat = fs.lstatSync(directory)
  if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0 || fs.realpathSync(directory) !== directory) throw new Error('PRIVATE_DIRECTORY_REQUIRED')
  const destination = join(directory, 'runtime.env')
  const existing = fs.lstatSync(destination, { throwIfNoEntry: false })
  if (existing) {
    if (!existing.isFile() || existing.uid !== process.getuid() || (existing.mode & 0o777) !== 0o600) throw new Error('PRIVATE_FILE_REQUIRED')
    return false
  }
  const secret = () => randomBytes(32).toString('hex')
  const databasePassword = secret()
  const values = {
    NGINX_PORT: `127.0.0.1:${port}`, APP_URL: `http://127.0.0.1:${port}`,
    APP_KEY: 'base64:' + randomBytes(32).toString('base64'), JWT_SECRET: secret(),
    DB_CONNECTION: 'pgsql', DB_HOST: 'postgres', DB_PORT: '5432',
    DB_DATABASE: 'pizza', DB_USERNAME: 'pizza', DB_PASSWORD: databasePassword,
    POSTGRES_DB: 'pizza', POSTGRES_USER: 'pizza', POSTGRES_PASSWORD: databasePassword,
    REDIS_PASSWORD: secret(), PRODUCTS_CACHE_TTL: '3600',
    RABBITMQ_USER: 'pizza', RABBITMQ_PASSWORD: secret(),
    MINIO_ROOT_USER: 'pizza', MINIO_ROOT_PASSWORD: secret(), MINIO_BUCKET: 'reports',
    // Required only while interpolating the base development Compose file.
    // All these published ports are removed by the production override.
    POSTGRES_PORT: '5432', REDIS_PORT: '6379', RABBITMQ_PORT: '5672',
    RABBITMQ_MANAGEMENT_PORT: '15672', MINIO_PORT: '9000', MINIO_CONSOLE_PORT: '9001',
  }
  const temporary = fs.mkdtempSync(join(directory, '.runtime-'))
  try {
    const staged = join(temporary, 'runtime.env')
    fs.writeFileSync(staged, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { flag: 'wx', mode: 0o600, flush: true })
    // Atomic, exclusive publication, including concurrent callers/symlinks.
    fs.linkSync(staged, destination)
    const fd = fs.openSync(directory, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    return true
  } finally { fs.rmSync(temporary, { recursive: true }) }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [directory, port, ...extra] = process.argv.slice(2)
    if (!directory || extra.length) throw new Error('INVALID_ARGUMENTS')
    console.log(createRuntime(resolve(directory), port) ? 'Private runtime file created.' : 'Existing private runtime file preserved; review its configuration separately.')
  } catch {
    process.stderr.write('Runtime preparation failed; check arguments, private directory and destination permissions. Existing files were not overwritten.\n')
    process.exitCode = 1
  }
}
