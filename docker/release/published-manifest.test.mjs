import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { publishedManifest } from './published-manifest.mjs'
import { validate } from './manifest.mjs'

const root = fileURLToPath(new URL('../../', import.meta.url))
const environment = { CI_REGISTRY_IMAGE: 'registry.example.test/team/pizza', CI_COMMIT_SHA: 'a'.repeat(40), CI_PIPELINE_ID: '123' }
const ids = ['sha256:' + 'b'.repeat(64), 'sha256:' + 'c'.repeat(64)]
const evidence = ['php', 'nginx'].map((service, index) => ({ id: ids[index], digests: [`${environment.CI_REGISTRY_IMAGE}/${service}@sha256:${String(index + 1).repeat(64)}`] }))
const yaml = fs.readFileSync(join(root, '.gitlab-ci.yml'), 'utf8').replaceAll('\r\n', '\n')

function fixture(run) {
  const directory = fs.mkdtempSync(join(tmpdir(), 'pizza-published-manifest-'))
  try {
    fs.mkdirSync(join(directory, 'reports'))
    fs.writeFileSync(join(directory, 'reports/production-images.ids'), ids.join('\n') + '\n')
    for (const [index, service] of ['php', 'nginx'].entries()) fs.writeFileSync(join(directory, `reports/published-${service}.json`), JSON.stringify(evidence[index]))
    return run(directory)
  } finally { fs.rmSync(directory, { recursive: true }) }
}

function cli(directory, overrides = {}) {
  return spawnSync(process.execPath, [join(root, 'docker/release/published-manifest.mjs'), join(directory, 'reports'), join(directory, 'release.json')], {
    encoding: 'utf8', env: { ...environment, SECRET: 'secret-canary', ...overrides },
  })
}

test('published manifest uses registry digests tied to checked image IDs and excludes shell overrides/secrets', () => fixture(directory => {
  assert.equal(cli(directory, { PHP_IMAGE: 'untrusted', NGINX_IMAGE: 'untrusted' }).status, 0)
  const text = fs.readFileSync(join(directory, 'release.json'), 'utf8')
  const manifest = validate(JSON.parse(text))
  assert.deepEqual(manifest.images, { php: evidence[0].digests[0], nginx: evidence[1].digests[0] })
  assert.equal(manifest.git_sha, environment.CI_COMMIT_SHA)
  assert.equal(manifest.pipeline_id, environment.CI_PIPELINE_ID)
  assert.equal(text.includes('secret-canary'), false)
  assert.equal(fs.statSync(join(directory, 'release.json')).mode & 0o777, 0o600)
  assert.equal(cli(directory).status, 1)
  assert.equal(fs.readFileSync(join(directory, 'release.json'), 'utf8'), text)
}))

test('missing, ambiguous, foreign, malformed digests and mismatched checked IDs fail closed', () => {
  for (const change of [
    { id: ids[1] }, { digests: null }, { digests: [null] }, { digests: [] },
    { digests: ['other.example.test/team/pizza/php@sha256:' + '1'.repeat(64)] },
    { digests: [evidence[0].digests[0], evidence[0].digests[0].replace(/1/g, '2')] },
    { digests: [environment.CI_REGISTRY_IMAGE + '/php@sha256:invalid'] },
  ]) assert.throws(() => publishedManifest(environment, ids.join('\n'), [{ ...evidence[0], ...change }, evidence[1]]))
  for (const invalid of ['', ids[0], ids.join('\n') + '\nextra', 'local-id\n' + ids[1]]) {
    assert.throws(() => publishedManifest(environment, invalid, evidence))
  }
})

for (const failure of ['missing-php', 'missing-nginx', 'broken-json', 'wrong-id', 'invalid-source']) {
  test(`${failure} leaves no manifest and prints no input contents`, () => fixture(directory => {
    if (failure.startsWith('missing-')) fs.unlinkSync(join(directory, `reports/published-${failure.slice(8)}.json`))
    if (failure === 'broken-json') fs.writeFileSync(join(directory, 'reports/published-nginx.json'), '{"secret-canary":')
    if (failure === 'wrong-id') fs.writeFileSync(join(directory, 'reports/production-images.ids'), ids.toReversed().join('\n'))
    const result = cli(directory, failure === 'invalid-source' ? { CI_COMMIT_SHA: 'secret-canary' } : {})
    assert.equal(result.status, 1)
    assert.equal(result.stdout, '')
    assert.equal(result.stderr.includes('secret-canary'), false)
    assert.equal(fs.existsSync(join(directory, 'release.json')), false)
  }))
}

test('CI publication records evidence only after both pushes; failures never reach manifest stage', () => fixture(directory => {
  const block = yaml.split('\npublish-production:\n')[1].split('\nrelease-manifest:\n')[0]
  const script = block.split('\n  script:\n')[1].split('\n  artifacts:\n')[0]
    .replace(/^    - \|\n/gm, '').replace(/^    - /gm, '').replace(/^      /gm, '')
  const archive = Buffer.from('controlled-image-archive')
  fs.writeFileSync(join(directory, 'reports/production-images.tar.gz'), archive)
  fs.writeFileSync(join(directory, 'reports/production-images.sha256'), createHash('sha256').update(archive).digest('hex') + '  reports/production-images.tar.gz\n')
  fs.mkdirSync(join(directory, 'docker/ci'), { recursive: true })
  fs.copyFileSync(join(root, 'docker/ci/check-release-tags.sh'), join(directory, 'docker/ci/check-release-tags.sh'))
  assert.match(block, /resource_group: application-release-publication/)
  const shim = join(directory, 'docker-shim')
  fs.writeFileSync(shim, `#!${process.execPath}
const fs = require('node:fs'); const args = process.argv.slice(2);
const calls = JSON.parse(fs.readFileSync(process.env.CALLS, 'utf8')); calls.push(args); fs.writeFileSync(process.env.CALLS, JSON.stringify(calls));
if (Number(process.env.FAIL_AT) === calls.length) process.exit(42);
if (args[0] === 'manifest') { console.error('no such manifest: ' + args[2]); process.exit(1); }
if (args[0] === 'image') {
  if (args.includes('{{.Id}}')) console.log(${JSON.stringify(ids.join('\n'))});
  else console.log(JSON.stringify(${JSON.stringify(evidence)}[args[2].includes('/php:') ? 0 : 1]));
}
`, { mode: 0o700 })
  fs.mkdirSync(join(directory, 'bin'))
  fs.symlinkSync(shim, join(directory, 'bin/docker'))
  const callsFile = join(directory, 'calls.json')
  for (const failAt of [0, 1, 2, 3, 4, 5, 6, 7, 8]) {
    fs.writeFileSync(callsFile, '[]')
    for (const service of ['php', 'nginx']) fs.rmSync(join(directory, `reports/published-${service}.json`), { force: true })
    const result = spawnSync('sh', ['-ec', script], { encoding: 'utf8', env: {
      ...environment, PATH: `${directory}/bin:${process.env.PATH}`, CI_PROJECT_DIR: directory, CALLS: callsFile, FAIL_AT: String(failAt),
    } })
    const calls = JSON.parse(fs.readFileSync(callsFile, 'utf8'))
    assert.equal(result.status, failAt ? ([3, 4].includes(failAt) ? 1 : 42) : 0, result.stderr)
    if (failAt) assert.equal(calls.length, failAt)
    else {
      assert.deepEqual(calls.map(args => args[0]), ['load', 'image', 'manifest', 'manifest', 'push', 'push', 'image', 'image'])
      assert.equal(cli(directory).status, 0)
    }
    if (failAt && failAt <= 6) assert.equal(fs.existsSync(join(directory, 'reports/published-php.json')), false)
  }
  const manifestJob = yaml.split('\nrelease-manifest:\n')[1]
  assert.equal(block.includes('docker build'), false)
  assert.equal(block.includes('needs:'), false)
  assert.match(block, /dependencies:\n    - production-integration\n/)
  // Corrupt artifacts must stop before even loading or inspecting an image.
  fs.writeFileSync(callsFile, '[]')
  fs.appendFileSync(join(directory, 'reports/production-images.tar.gz'), 'corruption')
  const corrupt = spawnSync('sh', ['-ec', script], { encoding: 'utf8', env: {
    ...environment, PATH: `${directory}/bin:${process.env.PATH}`, CI_PROJECT_DIR: directory, CALLS: callsFile,
  } })
  assert.notEqual(corrupt.status, 0)
  assert.deepEqual(JSON.parse(fs.readFileSync(callsFile, 'utf8')), [])
  assert.match(manifestJob, /stage: release\n/)
  assert.match(manifestJob, /dependencies:\n    - publish-production\n/)
  assert.match(manifestJob, /paths:\n      - reports\/release.json/)
  assert.equal(block.includes('when: always'), false)
  assert.equal(manifestJob.includes('when: always'), false)
}))
