import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { create } from './manifest.mjs'
import { DockerBackup } from './backup-docker.mjs'
import { identity } from './state.mjs'
import { jsonHash } from './coordinator.mjs'

// Existing local digest images only. No project env files, Registry, published
// infrastructure ports or existing volumes. This verifies the release protocol,
// not a fresh image build or the exact application revision inside those images.
test('real empty PostgreSQL bootstrap, Redis isolation lock, backup, readiness and repeat', {
  skip: process.env.BOOTSTRAP_DOCKER_TEST !== '1', timeout: 900000,
}, () => {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-bootstrap-docker-'))
  const project = 'pizza-bootstrap-test-' + randomBytes(6).toString('hex')
  const docker = new DockerBackup({ project })
  const root = new URL('../../', import.meta.url)
  const manifest = create({ CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '1',
    PHP_IMAGE: process.env.BOOTSTRAP_TEST_PHP_IMAGE, NGINX_IMAGE: process.env.BOOTSTRAP_TEST_NGINX_IMAGE })
  const stateDirectory = join(directory, 'state'), backupRoot = join(directory, 'backup'), bundle = join(directory, 'bundle')
  for (const path of [stateDirectory, backupRoot, bundle]) fs.mkdirSync(path, { mode: 0o700 })
  const runtime = join(directory, 'runtime.env')
  const secret = randomBytes(32).toString('hex')
  const values = { APP_URL: 'https://pizza.example.test', APP_KEY: 'base64:' + randomBytes(32).toString('base64'), JWT_SECRET: secret,
    DB_CONNECTION: 'pgsql', DB_HOST: 'postgres', DB_PORT: '5432', DB_DATABASE: 'bootstrap_test', DB_USERNAME: 'bootstrap_test', DB_PASSWORD: secret,
    POSTGRES_DB: 'bootstrap_test', POSTGRES_USER: 'bootstrap_test', POSTGRES_PASSWORD: secret, REDIS_PASSWORD: secret,
    RABBITMQ_USER: 'bootstrap_test', RABBITMQ_PASSWORD: secret, MINIO_ROOT_USER: 'bootstrap_test', MINIO_ROOT_PASSWORD: secret,
    MINIO_BUCKET: 'reports', NGINX_PORT: '80', PRODUCTS_CACHE_TTL: '3600', POSTGRES_PORT: '5432', REDIS_PORT: '6379',
    RABBITMQ_PORT: '5672', RABBITMQ_MANAGEMENT_PORT: '15672', MINIO_PORT: '9000', MINIO_CONSOLE_PORT: '9001' }
  fs.writeFileSync(runtime, Object.entries(values).map(([key, value]) => `${key}=${value}\n`).join(''), { mode: 0o600 })
  fs.writeFileSync(join(bundle, '.env'), '')
  for (const name of ['docker-compose.yml', 'docker-compose.prod.yml', 'docker-compose.release.yml']) fs.copyFileSync(new URL(name, root), join(bundle, name))
  const releaseCompose = join(bundle, 'docker-compose.release.yml')
  fs.writeFileSync(releaseCompose, fs.readFileSync(releaseCompose, 'utf8').replace('  nginx:', '  nginx:\n    ports: !override\n      - "127.0.0.1::80"'))
  const coordinator = new URL('./coordinator-docker.mjs', import.meta.url).href
  const bootstrap = new URL('./bootstrap.mjs', import.meta.url).href
  const script = `import {DockerCoordinator} from ${JSON.stringify(coordinator)};
    import {bootstrapRelease} from ${JSON.stringify(bootstrap)};
    class LocalCoordinator extends DockerCoordinator {images(manifest){super.images(manifest,false)}}
    const driver=new LocalCoordinator({schema_version:1,project:${JSON.stringify(project)},postgres_container:'0'.repeat(64),minio_container:'0'.repeat(64),utility_image:'sha256:'+'0'.repeat(64),reserve_bytes:67108864});
    try {bootstrapRelease(${JSON.stringify(stateDirectory)},${JSON.stringify(manifest)},${JSON.stringify(bundle)},${JSON.stringify(runtime)},${JSON.stringify(backupRoot)},driver)}
    catch(error){console.error(error.message);process.exitCode=1}
  `
  function run(code = script) {
    const result = spawnSync('sh', ['-ec', 'exec 9<"$TEST_DIRECTORY";flock -n -x 9;exec node --input-type=module -e "$TEST_CODE"'], {
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TEST_DIRECTORY: stateDirectory, TEST_CODE: code }, encoding: 'utf8', timeout: 600000,
    })
    assert.equal(result.stdout.includes(secret) || result.stderr.includes(secret), false, 'Runtime secret must not be logged')
    assert.equal(result.status, 0, result.stderr.replaceAll(secret, '[redacted]'))
  }
  try {
    run()
    const stateFile = join(stateDirectory, 'state.json'), before = fs.readFileSync(stateFile, 'utf8')
    assert.deepEqual(JSON.parse(before).current, manifest)
    assert.equal(JSON.parse(before).previous, null)
    const settings = JSON.parse(fs.readFileSync(join(stateDirectory, 'bootstrap', 'backup-settings.json')))
    docker.config = settings
    assert.equal(docker.pg('exec psql -X -At -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c "SELECT count(*)>0 FROM migrations"'), 't')
    const migration = JSON.parse(fs.readFileSync(join(stateDirectory, fs.readdirSync(stateDirectory).find(name => name.startsWith('launch-')), 'compose.json'))).services['release-migration']
    assert.equal(migration.environment.CACHE_STORE, 'redis')
    assert.ok(migration.command.includes('--isolated=75'))
    const php = docker.run(['ps', '-q', '--filter', `label=com.docker.compose.project=${project}`, '--filter', 'label=com.docker.compose.service=php'])
    // config:cache in the running application deliberately retains database
    // cache; select the migration's Redis store explicitly for this probe.
    const mutex = 'require "vendor/autoload.php"; $app=require "bootstrap/app.php"; $app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap(); config(["cache.default"=>"redis"]); $command=$app->make(Illuminate\\Database\\Console\\Migrations\\MigrateCommand::class); $mutex=new Illuminate\\Console\\CacheCommandMutex($app["cache"]); '
    docker.run(['exec', php, 'php', '-r', mutex + 'exit($mutex->create($command) ? 0 : 1);'])
    docker.run(['exec', php, 'php', '-r', mutex + 'exit(Illuminate\\Support\\Facades\\Artisan::call("migrate", ["--force"=>true,"--isolated"=>75,"--no-ansi"=>true]) === 75 ? 0 : 1);'])
    docker.run(['exec', php, 'php', '-r', mutex + '$mutex->forget($command);'])
    run()
    assert.equal(fs.readFileSync(stateFile, 'utf8'), before)
    if (process.env.RECOVERY_APP_DOCKER_TEST === '1') {
      const code = [
        'import assert from "node:assert/strict";import fs from "node:fs";',
        'import {backupRelease} from ' + JSON.stringify(new URL('./coordinator.mjs', import.meta.url).href) + ';',
        'import {continueRelease} from ' + JSON.stringify(new URL('./release-run.mjs', import.meta.url).href) + ';',
        'import {restoreRelease} from ' + JSON.stringify(new URL('./restore-release.mjs', import.meta.url).href) + ';',
        'import {readState} from ' + JSON.stringify(new URL('./state.mjs', import.meta.url).href) + ';',
        'import {DockerCoordinator} from ' + JSON.stringify(coordinator) + ';',
        'class LocalCoordinator extends DockerCoordinator {images(m){super.images(m,false)}}',
        'const directory=' + JSON.stringify(stateDirectory) + ',bundle=' + JSON.stringify(bundle) + ',runtime=' + JSON.stringify(runtime) + ',root=' + JSON.stringify(backupRoot) + ';',
        'const current=' + JSON.stringify(manifest) + ',failed={...current,pipeline_id:"2"};',
        'const settings=JSON.parse(fs.readFileSync(directory+"/bootstrap/backup-settings.json"));',
        'const driver=new LocalCoordinator(settings),raw=driver.backup.run.bind(driver.backup);',
        'const sql=q=>raw(["exec",settings.postgres_container,"psql","-X","-v","ON_ERROR_STOP=1","-At","-U","bootstrap_test","-d","bootstrap_test","-c",q]);',
        'const php=()=>raw(["ps","-q","--filter","label=com.docker.compose.project="+settings.project,"--filter","label=com.docker.compose.service=php"]);',
        'const base=' + JSON.stringify('require "vendor/autoload.php";$app=require "bootstrap/app.php";$app->make(Illuminate\\Contracts\\Console\\Kernel::class)->bootstrap();') + ';',
        'const put=value=>raw(["exec",php(),"php","-r",base+"Illuminate\\\\Support\\\\Facades\\\\Storage::disk(\\"s3\\")->put(\\"recovery.fixture\\","+JSON.stringify(value)+");"]);',
        'sql("CREATE TABLE recovery_fixture(value text);INSERT INTO recovery_fixture VALUES (\'baseline\')");put("baseline");',
        'backupRelease(directory,failed,bundle,runtime,root,driver);',
        'let altered=false;driver.backup.run=(args,options)=>{if(!altered&&args[0]==="exec"&&options?.input?.endsWith("release-readiness.php")){altered=true;sql("UPDATE recovery_fixture SET value=\'failed\';CREATE TABLE recovery_new_schema(id int)");put("failed");throw new Error("CONTROLLED_READINESS_FAILURE")}return raw(args,options)};',
        'assert.throws(()=>continueRelease(directory,failed,bundle,runtime,root,driver),/CONTROLLED_READINESS_FAILURE/);assert.ok(altered);driver.backup.run=raw;',
        'assert.equal(readState(directory).operation.phase,"starting");assert.equal(sql("SELECT value FROM recovery_fixture"),"failed");',
        'const recovered=restoreRelease(directory,failed,bundle,runtime,root,bundle,runtime,driver);',
        'assert.equal(recovered.operation,null);assert.deepEqual(recovered.current,current);',
        'const nextSettings=JSON.parse(fs.readFileSync(directory+"/recovery-"+' + JSON.stringify(identity({ ...manifest, pipeline_id: '2' })) + '+"/restore/backup-settings.json"));',
        'assert.equal(raw(["exec",nextSettings.postgres_container,"psql","-X","-At","-U","bootstrap_test","-d","bootstrap_test","-c","SELECT value FROM recovery_fixture"]),"baseline");',
        'assert.equal(raw(["exec",nextSettings.postgres_container,"psql","-X","-At","-U","bootstrap_test","-d","bootstrap_test","-c","SELECT to_regclass(\'public.recovery_new_schema\')"]),"");',
        'assert.equal(raw(["exec",php(),"php","-r",base+"echo Illuminate\\\\Support\\\\Facades\\\\Storage::disk(\\"s3\\")->get(\\"recovery.fixture\\");"]),"baseline");',
        'const bytes=fs.readFileSync(directory+"/state.json","utf8");restoreRelease(directory,failed,bundle,runtime,root,bundle,runtime,driver);assert.equal(fs.readFileSync(directory+"/state.json","utf8"),bytes);',
        'const future=driver.check(recovered,{...current,pipeline_id:"3"},bundle,runtime);assert.equal(future.volumes.pg_data_prod.name,recovered.data.postgres);assert.equal(future.volumes.minio_data_prod.name,recovered.data.minio);',
      ].join('\n')
      run(code)
    }
  } finally {
    // Delete only resources owned by the unique test project, including stopped
    // migration/placeholder containers and this test's named/anonymous volumes.
    const ids = docker.run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).split(/\s+/).filter(Boolean)
    for (const id of ids) {
      assert.equal(docker.inspect(id).Config.Labels['com.docker.compose.project'], project)
      docker.run(['rm', '-f', '-v', id], { discardOutput: true })
    }
    for (const name of fs.readdirSync(stateDirectory).filter(name => name.startsWith('recovery-'))) {
      const root = join(stateDirectory, name, 'restore')
      if (!fs.existsSync(join(root, 'plan.json'))) continue
      const plan = JSON.parse(fs.readFileSync(join(root, 'plan.json')))
      for (const attempt of fs.readdirSync(root).filter(name => /^data-\d+$/.test(name))) {
        const owner = jsonHash([identity(plan.initial_state.operation.manifest), plan.initial_state.revision, Number(attempt.slice(5))])
        for (const kind of ['container', 'volume']) {
          const targets = docker.run(kind === 'container' ? ['ps', '-aq', '--filter', 'label=pizza.data-recovery=' + owner]
            : ['volume', 'ls', '-q', '--filter', 'label=pizza.data-recovery=' + owner]).split(/\s+/).filter(Boolean)
          for (const target of targets) {
            const item = JSON.parse(docker.run([...(kind === 'container' ? [] : ['volume']), 'inspect', target]))[0]
            assert.equal((kind === 'container' ? item.Config.Labels : item.Labels)['pizza.data-recovery'], owner)
            docker.run(kind === 'container' ? ['rm', '-f', target] : ['volume', 'rm', target], { discardOutput: true })
          }
        }
      }
    }
    for (const kind of ['volume', 'network']) {
      const names = docker.run([kind, 'ls', '--filter', `label=com.docker.compose.project=${project}`, '--format', '{{.Name}}']).split(/\s+/).filter(Boolean)
      for (const name of names) {
        assert.equal(JSON.parse(docker.run([kind, 'inspect', name]))[0].Labels['com.docker.compose.project'], project)
        docker.run([kind, 'rm', name], { discardOutput: true })
      }
    }
    fs.rmSync(directory, { recursive: true })
  }
})
