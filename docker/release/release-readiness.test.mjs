import assert from 'node:assert/strict'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

// A private fake bootstrap tests the helper protocol without loading app/.env,
// the real application, a database or any network connection.
const helper = fileURLToPath(new URL('./release-readiness.php', import.meta.url))
for (const failure of ['', 'db', 'redis', 'rabbit', 's3']) {
  test(`dependency probe ${failure || 'success'} uses safe exit/output protocol`, () => {
    const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-readiness-'))
    try {
      fs.mkdirSync(join(directory, 'vendor'));fs.mkdirSync(join(directory, 'bootstrap'))
      fs.writeFileSync(join(directory, 'vendor/autoload.php'), `<?php
namespace { function probe($name) { if(getenv('PROBE_FAIL')===$name)throw new \\RuntimeException('secret-canary'); } function config($name) {return 'private-bucket-canary';} }
namespace Illuminate\\Contracts\\Console { interface Kernel {} }
namespace Illuminate\\Support\\Facades {
class DB {static function connection(){return new class { function select($query){\\probe('db');return [];} };} }
class Redis {static function connection(){return new class { function ping(){\\probe('redis');return true;} };} }
class Storage {static function disk($name){return new \\Illuminate\\Filesystem\\AwsS3V3Adapter();} }
}
namespace Illuminate\\Filesystem { class AwsS3V3Adapter {function getClient(){return new class {function listObjectsV2($args){\\probe('s3');return ['secret-canary'];} };} } }
namespace App\\Modules\\Report\\Infrastructure\\Messaging { class RabbitMqConnection {function connect(){\\probe('rabbit');return new class {function close(){}};} } }
`)
      fs.writeFileSync(join(directory, 'bootstrap/app.php'), `<?php return new class { function make($name) { if($name===\\Illuminate\\Contracts\\Console\\Kernel::class)return new class {function bootstrap(){}};return new $name();} };`)
      const result = spawnSync('php', [helper, directory], { encoding: 'utf8', env: { PATH: process.env.PATH, PROBE_FAIL: failure } })
      assert.equal(result.status, failure ? 1 : 0, result.stderr)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr, failure ? 'Release dependency readiness failed.\n' : '')
      assert.equal((result.stdout + result.stderr).includes('canary'), false)
    } finally { fs.rmSync(directory, { recursive: true }) }
  })
}
