import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { join, resolve } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { pathToFileURL } from 'node:url'
import { validate as validateManifest } from './manifest.mjs'
import { verifyFiles, verifyPreflight } from './backup-format.mjs'

const phases = ['prepared', 'images_ready', 'quiescing', 'quiesced', 'backup_ready', 'migrating', 'migrated', 'starting', 'verified', 'committed']
const phpServices = ['php', 'report-worker', 'outbox-worker', 'report-scheduler']
function requireCondition(condition) {
  if (!condition) throw new Error('Invalid release state or operation')
}
function fields(value, names) {
  requireCondition(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...names].sort().join(','))
}

export function identity(manifest) {
  validateManifest(manifest)
  return createHash('sha256').update(JSON.stringify([
    manifest.schema_version, manifest.git_sha, manifest.pipeline_id,
    manifest.deployment_config.version, manifest.deployment_config.git_sha,
    manifest.images.php, manifest.images.nginx,
  ])).digest('hex')
}

export function validateState(state) {
  fields(state, ['schema_version', 'project', 'revision', 'current', 'previous', 'operation'])
  requireCondition(state.schema_version === 1 && typeof state.project === 'string' &&
    /^[a-z0-9][a-z0-9_-]*$/.test(state.project) && state.project.trim() === state.project &&
    Number.isSafeInteger(state.revision) && state.revision >= 0)
  for (const manifest of [state.current, state.previous]) if (manifest !== null) validateManifest(manifest)
  requireCondition(state.previous === null || state.current !== null)
  if (state.operation !== null) {
    fields(state.operation, ['manifest', 'phase'])
    validateManifest(state.operation.manifest)
    requireCondition([...phases.slice(0, -1), 'rolling_back', 'recovery_required'].includes(state.operation.phase))
  }
  const releases = [state.current, state.previous, state.operation?.manifest].filter(Boolean)
  for (let i = 0; i < releases.length; i++) for (let j = i + 1; j < releases.length; j++) {
    requireCondition(releases[i].pipeline_id !== releases[j].pipeline_id)
    requireCondition(identity(releases[i]) !== identity(releases[j]))
  }
  if (state.revision === 0) requireCondition(releases.length === 0)
  return state
}

export function initialState(project) {
  return validateState({ schema_version: 1, project, revision: 0, current: null, previous: null, operation: null })
}

export function checkCandidate(state, manifest) {
  validateState(state)
  const id = identity(manifest)
  for (const stored of [state.current, state.previous, state.operation?.manifest].filter(Boolean)) {
    if (stored.pipeline_id === manifest.pipeline_id) requireCondition(identity(stored) === id)
  }
  if (state.operation) requireCondition(identity(state.operation.manifest) === id)
}

export function begin(state, manifest) {
  checkCandidate(state, manifest)
  if (state.operation || (state.current && identity(state.current) === identity(manifest))) return structuredClone(state)
  // A normal release cannot silently select a previous manifest; recovery is explicit.
  requireCondition(!state.previous || identity(state.previous) !== identity(manifest))
  return validateState({ ...structuredClone(state), revision: state.revision + 1,
    operation: { manifest: structuredClone(manifest), phase: 'prepared' } })
}

export function advance(state, manifest, phase) {
  checkCandidate(state, manifest)
  requireCondition(state.operation !== null && phases.includes(state.operation.phase))
  requireCondition(phases[phases.indexOf(state.operation.phase) + 1] === phase)
  const next = structuredClone(state)
  next.revision++
  if (phase === 'committed') {
    next.previous = next.current
    next.current = next.operation.manifest
    next.operation = null
  } else next.operation.phase = phase
  return validateState(next)
}

// Recovery never changes current/previous or runs reverse migrations.
export function recoveryTransition(state, phase) {
  validateState(state)
  requireCondition(state.operation)
  const from = state.operation.phase
  requireCondition((phase === 'rolling_back' && from === 'backup_ready') ||
    (phase === 'recovery_required' && ['migrating', 'migrated', 'starting', 'verified'].includes(from)) ||
    (phase === 'rollback_complete' && from === 'rolling_back'))
  const next = structuredClone(state)
  next.revision++
  if (phase === 'rollback_complete') next.operation = null
  else next.operation.phase = phase
  return validateState(next)
}

export function assertNoRecovery(directory, manifest) {
  requireCondition(fs.lstatSync(join(directory, `recovery-${identity(manifest)}`), { throwIfNoEntry: false }) === undefined)
}

export function readState(directory) {
  const file = join(directory, 'state.json')
  requireCondition(fs.lstatSync(file).isFile())
  return validateState(JSON.parse(fs.readFileSync(file, 'utf8')))
}

export function checkBackupCandidate(state, manifest, backup) {
  checkCandidate(state, manifest)
  requireCondition(state.operation !== null)
  const offset = { quiesced: 0, backup_ready: 1, migrating: 2 }[state.operation.phase]
  requireCondition(offset !== undefined)
  const source = state.current ?? state.operation.manifest
  requireCondition(backup.project === state.project && backup.release_id === identity(source) &&
    backup.git_sha === source.git_sha && backup.operation_id === identity(manifest) &&
    backup.state_revision === state.revision - offset)
}

export function assertOperationLock(directory) {
  // FD 9 must refer to this directory. flock locks the inherited open-file
  // description, so the lock remains held by the caller after this child exits.
  const descriptor = fs.fstatSync(9)
  const target = fs.statSync(directory)
  requireCondition(descriptor.isDirectory() && descriptor.dev === target.dev && descriptor.ino === target.ino)
  const stdio = Array(10).fill('ignore')
  stdio[9] = 9
  requireCondition(spawnSync('flock', ['-n', '-x', '9'], { stdio }).status === 0)
}

export function persist(directory, expected, next, evidence = {}) {
  assertOperationLock(directory)
  validateState(next)
  const file = join(directory, 'state.json')
  if (expected === null) {
    requireCondition(isDeepStrictEqual(next, initialState(next.project)))
  } else {
    validateState(expected)
    requireCondition(isDeepStrictEqual(readState(directory), expected))
    requireCondition(next.project === expected.project)
    // Only an exact no-op is allowed, after verifying the locked on-disk state.
    // Equality includes the full operation manifest, current/previous and revision.
    if (isDeepStrictEqual(expected, next)) return
    const recovering = ['rolling_back', 'recovery_required'].includes(next.operation?.phase) ||
      (expected.operation?.phase === 'rolling_back' && next.operation === null)
    const allowed = recovering ? recoveryTransition(expected, next.operation?.phase ?? 'rollback_complete') : expected.operation
      ? advance(expected, expected.operation.manifest, phases[phases.indexOf(expected.operation.phase) + 1])
      : next.operation ? begin(expected, next.operation.manifest) : expected
    if (recovering) {
      requireCondition(evidence.recovery)
      const plan = JSON.parse(fs.readFileSync(evidence.recovery, 'utf8'))
      const initial = validateState(plan.initial_state), backupState = validateState(plan.backup_state)
      requireCondition(initial.operation && initial.project === backupState.project && backupState.operation?.phase === 'backup_ready' &&
        identity(initial.operation.manifest) === identity(backupState.operation.manifest) &&
        isDeepStrictEqual(initial.current, backupState.current) && isDeepStrictEqual(initial.previous, backupState.previous) &&
        initial.revision - backupState.revision === ({ backup_ready: 0, migrating: 1, migrated: 2, starting: 3, verified: 4 }[initial.operation.phase]))
      const expectedFromPlan = expected.operation.phase === 'rolling_back' ? recoveryTransition(initial, 'rolling_back') : initial
      requireCondition(isDeepStrictEqual(expected, expectedFromPlan))
      checkBackupCandidate(backupState, initial.operation.manifest, verifyFiles(plan.backup_path))
    }
    requireCondition(isDeepStrictEqual(next, allowed))
    if (next.operation?.phase === 'quiescing') {
      verifyPreflight(evidence.preflight, expected.project, identity(expected.operation.manifest), expected.revision)
    }
    if (['backup_ready', 'migrating'].includes(next.operation?.phase)) {
      const backup = verifyFiles(evidence.backup)
      checkBackupCandidate(expected, expected.operation.manifest, backup)
    }
  }
  const temporary = fs.mkdtempSync(join(directory, '.state-'))
  try {
    const staged = join(temporary, 'state.json')
    fs.writeFileSync(staged, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600, flush: true })
    if (expected === null) fs.linkSync(staged, file)
    else fs.renameSync(staged, file)
    const fd = fs.openSync(directory, 'r')
    try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
  } finally {
    fs.rmSync(temporary, { recursive: true })
  }
}

export function composeProcessEnvironment(environment, manifest) {
  validateManifest(manifest)
  // CLI discovery/configuration and transport only. Application interpolation
  // comes from the explicit env files, never from the caller's shell.
  const inherited = [
    'PATH', 'HOME', 'XDG_CONFIG_HOME', 'XDG_RUNTIME_DIR',
    'DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'DOCKER_API_VERSION',
    'DOCKER_TLS', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH', 'SSH_AUTH_SOCK',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy',
    'SSL_CERT_FILE', 'SSL_CERT_DIR',
  ]
  const result = Object.fromEntries(inherited.filter(name => Object.hasOwn(environment, name))
    .map(name => [name, environment[name]]))
  return { ...result, COMPOSE_PROFILES: '', PHP_IMAGE: manifest.images.php, NGINX_IMAGE: manifest.images.nginx }
}

export function checkCompose(state, manifest, bundle, runtime, environment = process.env) {
  const result = spawnSync('docker', [
    'compose', '--project-name', state.project, '--project-directory', bundle,
    '--env-file', join(bundle, '.env'), '--env-file', runtime,
    '-f', join(bundle, 'docker-compose.yml'), '-f', join(bundle, 'docker-compose.prod.yml'),
    '-f', join(bundle, 'docker-compose.release.yml'), 'config', '--format', 'json',
  ], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024, timeout: 30000,
    env: composeProcessEnvironment(environment, manifest) })
  requireCondition(result.status === 0)
  const config = JSON.parse(result.stdout)
  requireCondition(config.name === state.project && !config.services.frontend)
  for (const service of Object.values(config.services)) {
    requireCondition(!service.build && !(service.volumes || []).some(volume => volume.type === 'bind'))
  }
  for (const name of [...phpServices, 'nginx']) {
    const service = config.services[name]
    requireCondition(service && service.image === (name === 'nginx' ? manifest.images.nginx : manifest.images.php))
    if (name !== 'nginx') requireCondition(service.environment.APP_ENV === 'production' && service.environment.APP_DEBUG === 'false')
  }
  return config
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, directory, ...args] = process.argv.slice(2)
    requireCondition(directory && ((command === 'status' && args.length === 0) || (command === 'check' && args.length === 3)))
    assertOperationLock(directory)
    const state = readState(directory)
    if (command === 'check') {
      const manifest = validateManifest(JSON.parse(fs.readFileSync(args[0], 'utf8')))
      checkCandidate(state, manifest)
      checkCompose(state, manifest, resolve(args[1]), resolve(args[2]))
      console.log('Release checks passed; no changes performed.')
    } else {
      // Print only fixed labels and validated opaque IDs, never state contents.
      console.log(JSON.stringify({ project: state.project, revision: state.revision,
        current: state.current ? identity(state.current) : null,
        previous: state.previous ? identity(state.previous) : null,
        phase: state.operation?.phase ?? 'idle' }))
    }
  } catch {
    process.stderr.write('Release state check failed; verify arguments, lock, state and configuration.\n')
    process.exitCode = 1
  }
}
