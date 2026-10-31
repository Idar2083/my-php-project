import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = fileURLToPath(new URL('../../', import.meta.url))
const script = join(root, 'docker/ci/check-minio-images.sh')
const registry = 'registry.example.test/team/pizza'
const source = {
  PATH: process.env.PATH, CI_REGISTRY_IMAGE: registry, CI_JOB_ID: '123',
  MINIO_CI_IMAGE: `${registry}/minio-community@sha256:${'a'.repeat(64)}`,
  MINIO_MC_CI_IMAGE: `${registry}/mc-community@sha256:${'b'.repeat(64)}`,
}

test('CI accepts only complete project server/client digest references, without Docker', () => {
  const run = (change = {}, args = ['--validate-only']) => spawnSync('sh', [script, ...args], {
    cwd: root, env: { ...source, ...change }, encoding: 'utf8',
  })
  assert.equal(run().status, 0)
  for (const key of ['MINIO_CI_IMAGE', 'MINIO_MC_CI_IMAGE']) {
    for (const value of ['', 'minio/minio:latest', 'pizza-minio-trial/server:trial-test',
      source[key].replace(/@sha256:.*/, ':release'), source[key].replace(registry, 'registry.example.test/other'),
      source[key].slice(0, -1), `${source[key]}\n`, source[key].toUpperCase(),
      source[key].replace('@sha256:', '@sha256:invalid@sha256:'), source[key] + ';canary']) {
      const result = run({ [key]: value })
      assert.equal(result.status, 1)
      assert.equal(result.stdout, '')
      assert.ok(!result.stderr.includes(value) || value === '')
    }
  }
  assert.equal(run({ MINIO_MC_CI_IMAGE: source.MINIO_CI_IMAGE }).status, 1)
  assert.equal(run({ CI_REGISTRY_IMAGE: '' }).status, 1)
  assert.equal(run({}, ['--unknown']).status, 1)
})

test('contract failure blocks publication; helper receives public test and refs, not credentials', () => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'pizza-minio-ci-'))
  try {
    const calls = join(folder, 'calls.jsonl')
    fs.writeFileSync(join(folder, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'run') {
  const input = fs.readFileSync(0, 'utf8');
  if (!input.includes('idempotent bucket-init') || input.includes('registry-secret-canary')) process.exit(99);
}
process.exit(args[0] === process.env.FAIL_OPERATION ? 42 : 0);
`, { mode: 0o700 })
    function run(mode = [], fail = '') {
      fs.writeFileSync(calls, '')
      const result = spawnSync('sh', [script, ...mode], { cwd: root, encoding: 'utf8',
        env: { ...source, PATH: `${folder}:${source.PATH}`, CALLS: calls, FAIL_OPERATION: fail,
          CI_REGISTRY_PASSWORD: 'registry-secret-canary' } })
      const commands = fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse)
      return { result, commands }
    }
    const success = run()
    assert.equal(success.result.status, 0, success.result.stderr)
    assert.deepEqual(success.commands.map(args => args[0]), ['pull', 'pull', 'build', 'run'])
    assert.deepEqual(success.commands.slice(0, 2), [['pull', source.MINIO_CI_IMAGE], ['pull', source.MINIO_MC_CI_IMAGE]])
    const helper = success.commands[3]
    for (const flag of ['--rm', '--pull=never', '--network=none', '--read-only']) assert.ok(helper.includes(flag))
    assert.ok(helper.includes(`MINIO_TEST_CLIENT_IMAGE=${source.MINIO_MC_CI_IMAGE}`))
    assert.ok(helper.includes(`MINIO_TEST_SERVER_IMAGE=${source.MINIO_CI_IMAGE}`))
    assert.ok(!JSON.stringify(success.commands).includes('registry-secret-canary'))
    for (const failure of ['pull', 'build', 'run']) {
      const failed = run([], failure)
      assert.equal(failed.result.status, 42)
      assert.equal(failed.commands.at(-1)[0], failure)
    }
    assert.deepEqual(run(['--pull-only']).commands.map(args => args[0]), ['pull', 'pull'])
  } finally { fs.rmSync(folder, { recursive: true }) }
})

test('CI separates infrastructure contracts from independent checks and preserves production barriers', () => {
  const ci = fs.readFileSync(join(root, '.gitlab-ci.yml'), 'utf8').replaceAll('\r\n', '\n')
  const job = name => ci.split(`\n${name}:\n`)[1]?.split(/\n(?=[a-z][a-z-]*:\n)/)[0]
  assert.ok(!job('build').includes('check-minio-images.sh'))
  assert.ok(job('minio-images').includes('    - sh docker/ci/check-minio-images.sh\n'))
  assert.ok(job('tests').includes('needs: [build, minio-images]'))
  for (const name of ['phpstan', 'php-cs-fixer', 'rector']) assert.ok(job(name).includes('needs: [build]'))
  for (const name of ['frontend', 'release-checks', 'production-config']) assert.ok(job(name).includes('needs: []'))
  for (const name of ['production-integration', 'publish-production', 'release-manifest', 'deploy-production']) {
    assert.ok(!/^  needs:/m.test(job(name)), `${name} must retain the stage barrier`)
    assert.ok(!/^  allow_failure: true/m.test(job(name)))
  }
  assert.match(ci, /name: "\$MINIO_CI_IMAGE"\n      alias: minio\n      command:\n        - server\n        - \/data/)
  assert.ok(!ci.includes('minio/minio:latest'))
  const integration = ci.split('\nproduction-integration:\n')[1].split('\npublish-production:\n')[0]
  assert.ok(integration.includes('before_script: *registry-login'))
  const shell = fs.readFileSync(join(root, 'docker/ci/production-integration.sh'), 'utf8')
  assert.ok(shell.indexOf('--pull-only') < shell.indexOf('docker create'))
  assert.ok(shell.includes('-e "MINIO_IMAGE=$MINIO_CI_IMAGE" -e "MINIO_MC_IMAGE=$MINIO_MC_CI_IMAGE"'))
  assert.ok(shell.indexOf('sh docker/ci/archive-production-source.sh') < shell.indexOf('--pull-only'))
  const helper = fs.readFileSync(join(root, 'frontend/tests-production/run.js'), 'utf8')
  assert.ok(helper.includes('assert.equal(config.services[service].image, reference)'))
  assert.ok(helper.indexOf('assert.equal(config.services[service].image, reference)') < helper.indexOf("compose('build'"))
})

test('production archive rejects incomplete, dirty or mismatched checkouts before archiving', () => {
  const folder = fs.mkdtempSync(join(tmpdir(), 'pizza-source-ci-'))
  try {
    const calls = join(folder, 'calls.jsonl')
    fs.writeFileSync(join(folder, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.CALLS, JSON.stringify(args) + '\\n');
if (args[0] === 'rev-parse') process.stdout.write(process.env.FAKE_HEAD);
if (args[0] === 'ls-files' && args.includes('--error-unmatch') && process.env.MODE === 'missing') process.exit(1);
if (args[0] === 'diff' && process.env.MODE === 'dirty') process.exit(1);
if (args[0] === 'ls-files' && args.includes('--others') && process.env.MODE === 'untracked') process.stdout.write('docker/minio/Dockerfile.mc\\n');
if (args[0] === 'archive') fs.writeFileSync('reports/production-check.source.tar', 'fake committed archive');
`, { mode: 0o700 })
    const sha = 'c'.repeat(40)
    const archive = join(folder, 'reports/production-check.source.tar')
    const run = (mode = '', commit = sha) => {
      fs.writeFileSync(calls, '')
      fs.rmSync(archive, { force: true })
      const result = spawnSync('sh', [join(root, 'docker/ci/archive-production-source.sh')], {
        encoding: 'utf8', env: { PATH: `${folder}:${process.env.PATH}`, CI_PROJECT_DIR: folder,
          CI_COMMIT_SHA: commit, FAKE_HEAD: sha, MODE: mode, CALLS: calls },
      })
      return { result, commands: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) }
    }
    const valid = run()
    assert.equal(valid.result.status, 0, valid.result.stderr)
    assert.ok(fs.existsSync(archive))
    assert.deepEqual(valid.commands.at(-1), ['archive', '--format=tar', '--output=reports/production-check.source.tar', 'HEAD'])
    const required = valid.commands.find(args => args.includes('--error-unmatch'))
    for (const file of ['docker/minio/images.test.mjs', 'docker/minio/Dockerfile.mc',
      'docker/ci/check-minio-images.sh', 'frontend/tests-production/run.js']) assert.ok(required.includes(file))
    for (const mode of ['missing', 'dirty', 'untracked']) {
      const failed = run(mode)
      assert.equal(failed.result.status, 1)
      assert.ok(!failed.commands.some(args => args[0] === 'archive'))
      assert.ok(!fs.existsSync(archive))
    }
    for (const commit of ['', 'd'.repeat(40)]) {
      const failed = run('', commit)
      assert.equal(failed.result.status, 1)
      assert.ok(!failed.commands.some(args => args[0] === 'archive'))
    }
  } finally { fs.rmSync(folder, { recursive: true }) }
})
