import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'

// Opt-in only: existing local images, no pulls, host ports, production env or data.
test('community images support read-only server, health endpoints and idempotent bucket-init', {
  skip: process.env.MINIO_IMAGE_DOCKER_TEST !== '1', timeout: 120000,
}, async () => {
  const environment = { PATH: process.env.PATH, HOME: process.env.HOME, DOCKER_HOST: 'unix:///var/run/docker.sock' }
  function docker(...args) {
    const result = spawnSync('docker', args, { env: environment, encoding: 'utf8', timeout: 30000 })
    assert.equal(result.status, 0, result.stderr)
    return result.stdout.trim()
  }
  const owner = randomUUID()
  const serverReference = process.env.MINIO_TEST_SERVER_IMAGE || 'pizza-infra/minio-community:RELEASE.2025-10-15T17-29-55Z'
  const clientReference = process.env.MINIO_TEST_CLIENT_IMAGE || 'pizza-infra/mc-community:RELEASE.2025-08-13T08-35-41Z'
  const server = JSON.parse(docker('image', 'inspect', serverReference))[0]
  const client = JSON.parse(docker('image', 'inspect', clientReference))[0]
  for (const image of [server, client]) {
    assert.equal(image.Os, 'linux')
    assert.equal(image.Architecture, 'amd64')
  }
  let container
  try {
    container = docker('create', '--pull=never', '--network=none', '--read-only',
      '--label', `pizza.minio-image-test=${owner}`, '--tmpfs', '/data:rw', '--tmpfs', '/tmp:rw,nosuid,nodev',
      '--env', 'MINIO_ROOT_USER=fixtureuser', '--env', 'MINIO_ROOT_PASSWORD=fixturepassword',
      server.Id, 'server', '/data', '--console-address', ':9001')
    docker('start', container)
    let ready = false
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = spawnSync('docker', ['exec', container, 'curl', '-fsS', 'http://127.0.0.1:9000/minio/health/ready'],
        { env: environment, stdio: 'ignore', timeout: 1000 })
      if (result.status === 0) { ready = true; break }
      await delay(100)
    }
    assert.ok(ready, 'Server must become ready without a writable root filesystem')
    docker('exec', container, 'curl', '-fsS', 'http://127.0.0.1:9000/minio/health/live')
    docker('exec', container, '/bin/sh', '-ec',
      'test "$HOME" = /tmp; test -s /etc/ssl/certs/ca-certificates.crt; touch /data/write-probe /tmp/write-probe; ! touch /root-write-probe 2>/dev/null')
    assert.ok(docker('exec', container, 'minio', '--version').includes('9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a'))
    // The isolated client shares only this server's loopback namespace. Production
    // uses the same commands against http://minio:9000 on its Compose network.
    docker('run', '--rm', '--name', `pizza-minio-client-test-${owner}`, '--label', `pizza.minio-image-test=${owner}`,
      '--pull=never', `--network=container:${container}`, '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev',
      '--env', 'MINIO_ROOT_USER=fixtureuser',
      '--env', 'MINIO_ROOT_PASSWORD=fixturepassword', '--env', 'MINIO_BUCKET=image-contract',
      '--entrypoint', '/bin/sh', client.Id, '-ec', `
        test "$HOME" = /tmp
        test -z "$MC_CONFIG_DIR"
        test -s /etc/ssl/certs/ca-certificates.crt
        mc --version | grep -F 7394ce0dd2a80935aded936b09fa12cbb3cb8096
        mc alias set local http://127.0.0.1:9000 "$MINIO_ROOT_USER" "$MINIO_ROOT_PASSWORD"
        mc mb --ignore-existing "local/$MINIO_BUCKET"
        mc mb --ignore-existing "local/$MINIO_BUCKET"
        printf image-contract | mc pipe "local/$MINIO_BUCKET/probe"
        mc stat "local/$MINIO_BUCKET/probe"
        test "$(mc cat "local/$MINIO_BUCKET/probe")" = image-contract
      `)
  } finally {
    const owned = docker('ps', '-aq', '--filter', `label=pizza.minio-image-test=${owner}`).split(/\s+/).filter(Boolean)
    for (const id of owned) {
      assert.equal(docker('inspect', '--format', '{{index .Config.Labels "pizza.minio-image-test"}}', id), owner)
      docker('rm', '-f', id)
    }
  }
})
