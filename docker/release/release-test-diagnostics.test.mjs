import assert from 'node:assert/strict'
import test from 'node:test'
import { fixtureFailure } from './release-test-diagnostics.mjs'
import { ensure } from './backup-format.mjs'

test('fixture diagnostics identify the operation and release source without arbitrary error data', () => {
  let error
  try { ensure(false, 'INSUFFICIENT_BACKUP_SPACE') } catch (caught) { error = caught }
  const output = fixtureFailure(error, 'backupRelease')
  assert.match(output, /"operation":"backupRelease"/)
  assert.match(output, /"code":"INSUFFICIENT_BACKUP_SPACE"/)
  assert.match(output, /backup-format\.mjs:\d+:\d+/)
  assert.doesNotMatch(output, /file:\/\/|\/home\/|\/tmp\//)
})

test('fixture diagnostics suppress messages, paths, unknown codes and operation values', () => {
  const error = new Error('RESTORE_SECRET_CANARY password=secret-canary')
  error.code = 'SECRET_CANARY'
  error.stack += '\n    at secret-canary (/tmp/secret-canary/backup.mjs:26:3)'
  const output = fixtureFailure(error, 'secret-canary')
  assert.match(output, /"operation":"unknown"/)
  assert.match(output, /"code":"UNCLASSIFIED"/)
  assert.match(output, /backup\.mjs:26:3/)
  assert.doesNotMatch(output, /[Cc][Aa][Nn][Aa][Rr][Yy]|password|\/tmp\//)
  assert.match(fixtureFailure({ code: 'ENOSPC' }, 'backupRelease'), /"code":"ENOSPC"/)
})
