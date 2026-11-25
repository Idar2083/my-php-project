import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import test from 'node:test'

test('publication rejects existing tags and Registry errors without disclosing diagnostics', () => {
  const directory = mkdtempSync(join(tmpdir(), 'pizza-tag-check-'))
  try {
    writeFileSync(join(directory, 'docker'), `#!/bin/sh
case "$MODE:$3" in
  absent:*|partial:*/php:123) echo "no such manifest: $3" >&2; exit 1 ;;
  existing:*|partial:*) exit 0 ;;
  *) echo 'secret-canary: authentication/network failure' >&2; exit 1 ;;
esac
`, { mode: 0o700 })
    for (const mode of ['absent', 'existing', 'partial', 'error']) {
      const result = spawnSync('sh', ['docker/ci/check-release-tags.sh'], {
        encoding: 'utf8', env: {
          PATH: `${directory}:${process.env.PATH}`, MODE: mode,
          CI_REGISTRY_IMAGE: 'registry.example.test/team/pizza', CI_PIPELINE_ID: '123',
        },
      })
      assert.equal(result.status, mode === 'absent' ? 0 : 1)
      assert.equal(result.stdout, '')
      assert.equal(result.stderr.includes('secret-canary'), false)
    }
  } finally { rmSync(directory, { recursive: true }) }
})
