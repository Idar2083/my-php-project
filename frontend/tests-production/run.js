import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout } from 'node:timers/promises'

const frontend = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const root = resolve(frontend, '..')
// The project name, credentials, volumes and port are never taken from the user's deployment.
const project = `pizza-stage122-${randomBytes(6).toString('hex')}`
const directory = mkdtempSync(join(tmpdir(), `${project}-`))
const password = randomBytes(24).toString('hex')
const values = {
  COMPOSE_PROJECT_NAME: project, COMPOSE_PROFILES: '', NGINX_PORT: '80',
  APP_KEY: `base64:${randomBytes(32).toString('base64')}`,
  APP_URL: 'http://localhost', JWT_SECRET: randomBytes(32).toString('hex'),
  POSTGRES_DB: 'stage122_test', POSTGRES_USER: 'stage122_test', POSTGRES_PASSWORD: password,
  DB_CONNECTION: 'pgsql', DB_HOST: 'postgres', DB_PORT: '5432',
  DB_DATABASE: 'stage122_test', DB_USERNAME: 'stage122_test', DB_PASSWORD: password,
  REDIS_PASSWORD: randomBytes(24).toString('hex'),
  RABBITMQ_USER: 'stage122_test', RABBITMQ_PASSWORD: randomBytes(24).toString('hex'),
  MINIO_ROOT_USER: 'stage122_test', MINIO_ROOT_PASSWORD: randomBytes(24).toString('hex'),
  MINIO_BUCKET: 'reports', PRODUCTS_CACHE_TTL: '3600',
}
const environment = { ...process.env, ...values }
const envFile = join(directory, 'test.env')
writeFileSync(envFile, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 })
const fixtures = {
  '.env': 'STAGE122_PUBLIC_CANARY\n',
  'review.js.map': '{"review":"STAGE122_MAP_CANARY"}\n',
  'review.txt': 'mutable static fixture\n',
}
for (const [name, contents] of Object.entries(fixtures)) writeFileSync(join(directory, name), contents)
const override = join(directory, 'override.yml')
writeFileSync(override, `services:
  nginx:
    ports: !override
      - "127.0.0.1::80"
    volumes:
${Object.keys(fixtures).map(name => `      - ${JSON.stringify(`${join(directory, name)}:/usr/share/nginx/html/assets/${name}:ro`)}`).join('\n')}
`)
const composeArgs = [
  'compose', '--project-name', project,
  '--env-file', join(root, '.env'), '--env-file', envFile,
  '-f', join(root, 'docker-compose.yml'), '-f', join(root, 'docker-compose.prod.yml'), '-f', override,
]
function run(command, args, { capture = false, env = environment } = {}) {
  const result = spawnSync(command, args, {
    cwd: root, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 1200000,
  })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} failed (exit ${result.status})`)
  return result.stdout?.trim()
}
const compose = (...args) => run('docker', [...composeArgs, ...args])
const capture = (...args) => run('docker', [...composeArgs, ...args], { capture: true })

console.log(`Isolated production check: ${project} (temporary configuration: ${directory})`)
try {
  compose('config', '--quiet')
  const config = JSON.parse(capture('config', '--format', 'json'))
  assert.equal(config.services.php.build.target, 'prod')
  assert.equal(config.services.php.user, 'www-data')
  assert.equal(config.services.php.volumes?.length || 0, 0)
  assert.equal(config.services.nginx.build.target, 'prod')
  assert.equal(config.services.nginx.volumes.length, Object.keys(fixtures).length)
  assert.equal(config.services.nginx.ports.length, 1)
  assert.equal(config.services.nginx.ports[0].host_ip, '127.0.0.1')
  for (const service of ['postgres', 'redis', 'rabbitmq', 'minio']) {
    assert.equal(config.services[service].ports?.length || 0, 0, service)
  }
  for (const key of ['APP_KEY', 'JWT_SECRET']) {
    const missing = spawnSync('docker', [...composeArgs, 'config', '--quiet'], {
      cwd: root, env: { ...environment, [key]: '' }, encoding: 'utf8', timeout: 30000,
    })
    assert.equal(missing.status, 1)
    assert.ok(missing.stderr.includes(key))
  }
  compose('build', 'php', 'nginx')
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180', 'php', 'nginx')
  compose('exec', '-T', 'nginx', 'nginx', '-t')
  compose('exec', '-T', 'nginx', 'sh', '-c', 'test ! -e /usr/share/nginx/html/src && ! command -v node')
  compose('exec', '-T', 'php', 'sh', '-c', 'test ! -e .env && test ! -e auth.json && test ! -e var && test ! -e database/database.sqlite')
  // These migrations and fixtures can only reach this randomly named project's new PostgreSQL volume.
  compose('exec', '-T', 'php', 'php', 'artisan', 'migrate', '--force')
  const fixture = JSON.parse(capture('exec', '-T', 'php', 'php', '-r', `
    require 'vendor/autoload.php';
    $app = require 'bootstrap/app.php';
    $app->make(\\Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();
    for ($i = 1; $i <= 31; $i++) {
      \\App\\Modules\\Catalog\\Domain\\Models\\Product::create([
        'name' => 'Stage 12.2 product '.$i, 'price' => 12.50,
        'category' => 'pizza', 'weight' => '0.500', 'description' => null,
      ]);
    }
    $user = \\App\\Modules\\Auth\\Domain\\Models\\User::create([
      'name' => 'Stage 12.2 user', 'email' => 'stage122@example.test',
      'password' => bin2hex(random_bytes(32)),
    ]);
    echo json_encode(['token' => app('tymon.jwt.auth')->fromUser($user), 'email' => $user->email]);
  `))
  const address = capture('port', 'nginx', '80')
  assert.match(address, /^127\.0\.0\.1:\d+$/)
  const testEnvironment = {
    ...environment, PRODUCTION_URL: `http://${address}`, PRODUCTION_FIXTURES: '1',
    PRODUCTION_TEST_TOKEN: fixture.token, PRODUCTION_TEST_USER_EMAIL: fixture.email,
  }
  const check = file => run(process.execPath, ['--test', join(frontend, 'tests-production', file)], { env: testEnvironment })
  check('http.test.js')
  compose('stop', 'php')
  check('backend-down.test.js')
  // Check recovery after PHP recreation without restarting Nginx.
  compose('up', '-d', '--no-build', '--wait', '--wait-timeout', '180', '--force-recreate', 'php')
  const deadline = Date.now() + 35000
  while (true) {
    try {
      const response = await fetch(`${testEnvironment.PRODUCTION_URL}/up`, { signal: AbortSignal.timeout(6000) })
      if (response.status === 200) break
    } catch { /* DNS may still refer to the previous PHP container for up to 30 seconds. */ }
    assert.ok(Date.now() < deadline, 'API did not recover after PHP recreation')
    await setTimeout(500)
  }
  check('http.test.js')
  const phpLogs = capture('logs', '--no-color', 'php')
  const nginxLogs = capture('logs', '--no-color', 'nginx')
  assert.ok(!/ERROR|CRITICAL|Fatal error|Uncaught/.test(phpLogs), 'PHP logs contain application errors')
  const runtimeLogs = `${phpLogs}\n${nginxLogs}`
  for (const secret of [
    values.APP_KEY, values.JWT_SECRET, values.DB_PASSWORD, values.REDIS_PASSWORD,
    values.RABBITMQ_PASSWORD, values.MINIO_ROOT_PASSWORD, fixture.token,
  ]) {
    assert.ok(!runtimeLogs.includes(secret), 'Runtime logs contain a test secret')
  }
  console.log('PHP logs contain no application errors; test secrets are absent from PHP/Nginx logs')
} finally {
  // Only resources belonging to our generated project are removed, including its disposable DB.
  compose('down', '--volumes', '--remove-orphans')
  rmSync(directory, { recursive: true })
}
