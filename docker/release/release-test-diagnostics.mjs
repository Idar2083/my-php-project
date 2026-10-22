// Test subprocesses must identify a failing contract without printing arbitrary
// exception messages, runtime configuration, argv or Docker stderr.
const operations = new Set(['prepareBackup', 'backupRelease', 'bootstrapRelease', 'continueRelease', 'recoverRelease', 'restoreRelease'])
const codes = new Set(['INVALID_BACKUP', 'INSUFFICIENT_BACKUP_SPACE', 'BACKUP_ROOT_MUST_BE_PRIVATE',
  'QUIESCE_PLAN_CHANGED', 'WRITERS_CHANGED', 'WRITER_STATE_CHANGED', 'RELEASE_SERVICE_UNHEALTHY',
  'RELEASE_HEALTH_TIMEOUT', 'RELEASE_CONFIG_CHANGED', 'ENOSPC', 'EACCES', 'ENOENT', 'EMFILE', 'ENFILE'])

export function fixtureFailure(error, operation) {
  const code = codes.has(error?.message) ? error.message : codes.has(error?.code) ? error.code : 'UNCLASSIFIED'
  const frames = String(error?.stack || '').split('\n').slice(1).flatMap(line => {
    const match = line.match(/\/(state|backup|backup-format|backup-docker|coordinator|coordinator-docker|release-run|release-runtime|bootstrap|recovery|recovery-runtime|restore-release|restore-runtime|restore-data)\.mjs:(\d+):(\d+)\)?$/)
    return match ? [`${match[1]}.mjs:${match[2]}:${match[3]}`] : []
  }).slice(0, 6)
  return 'Release fixture failed: ' + JSON.stringify({ operation: operations.has(operation) ? operation : 'unknown', code, frames }) + '\n'
}
