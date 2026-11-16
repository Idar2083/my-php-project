import fs from 'node:fs'
import { join, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { hash, parseBundle, readPrivateFile, requireValue, serverRoot } from './deploy-bundle.mjs'

function privateDirectory(path) {
  const stat = fs.lstatSync(path)
  requireValue(stat.isDirectory() && stat.uid === process.getuid() && (stat.mode & 0o077) === 0 && fs.realpathSync(path) === path)
}
export function installBundle(root, bytes, expected, checksum) {
  const bundle = parseBundle(bytes, expected, checksum)
  serverRoot(root)
  for (const name of ['', 'releases', 'shared', 'shared/state', 'shared/backups']) privateDirectory(join(root, name))
  const destination = join(root, 'releases', expected.tag + '-' + expected.pipeline)
  const contents = { ...Object.fromEntries(Object.entries(bundle.files).map(([path, file]) => [path, file.content])),
    '.env': '', 'release.json': JSON.stringify(bundle.manifest) + '\n', 'delivery.json': JSON.stringify(bundle.release) + '\n' }
  if (!fs.existsSync(destination)) {
    const temporary = fs.mkdtempSync(join(root, 'releases', '.incoming-'))
    try {
      for (const [path, content] of Object.entries(contents)) {
        fs.mkdirSync(join(temporary, dirname(path)), { recursive: true, mode: 0o700 })
        fs.writeFileSync(join(temporary, path), content, { flag: 'wx', mode: 0o600, flush: true })
      }
      fs.renameSync(temporary, destination)
      const fd = fs.openSync(join(root, 'releases'), 'r')
      try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
    } finally { if (fs.existsSync(temporary)) fs.rmSync(temporary, { recursive: true }) }
  }
  privateDirectory(destination)
  const inventory = folder => fs.readdirSync(folder).flatMap(name => {
    const path = join(folder, name), stat = fs.lstatSync(path)
    requireValue(!stat.isSymbolicLink())
    return stat.isDirectory() ? inventory(path) : [path.slice(destination.length + 1)]
  })
  requireValue(inventory(destination).sort().join() === Object.keys(contents).sort().join())
  for (const [path, content] of Object.entries(contents)) {
    // Refuse directory symlinks as well as file symlinks on retry.
    let parent = dirname(join(destination, path))
    while (parent !== destination) { privateDirectory(parent);parent = dirname(parent) }
    requireValue(hash(readPrivateFile(join(destination, path))) === hash(content))
  }
  return { bundle, destination }
}
export function runCoordinator(api, directory, manifest, bundle, runtime, backupRoot, driver) {
  api.assertOperationLock(directory)
  const state = api.readState(directory)
  requireValue(state.current)
  requireValue(manifest.pipeline_id === state.current.pipeline_id || BigInt(manifest.pipeline_id) > BigInt(state.current.pipeline_id))
  // Resume only this candidate. Existing phase/evidence/health checks remain authoritative.
  api.checkCandidate(state, manifest)
  if (!state.operation || ['prepared', 'images_ready', 'quiescing', 'quiesced', 'backup_ready'].includes(state.operation.phase)) {
    api.backupRelease(directory, manifest, bundle, runtime, backupRoot, driver)
  }
  return api.continueRelease(directory, manifest, bundle, runtime, backupRoot, driver)
}
export async function receive(root, bytes, expected, checksum, load = async path => {
  const module = name => import(pathToFileURL(join(path, 'docker/release', name)).href)
  return Object.assign({}, ...await Promise.all(['state.mjs', 'coordinator.mjs', 'release-run.mjs', 'backup.mjs', 'coordinator-docker.mjs'].map(module)))
}) {
  const { bundle, destination } = installBundle(root, bytes, expected, checksum)
  const directory = join(root, 'shared/state')
  if (!fs.existsSync(join(directory, 'state.json'))) throw new Error('FIRST_BOOTSTRAP_REQUIRED')
  // Only validated files are imported. No runtime secrets are included in the bundle.
  const api = await load(destination)
  const runtime = join(root, 'shared/runtime.env'), settings = join(root, 'shared/backup-settings.json')
  readPrivateFile(runtime)
  const driver = new api.DockerCoordinator(api.config(JSON.parse(readPrivateFile(settings))))
  return runCoordinator(api, directory, bundle.manifest, destination, runtime, join(root, 'shared/backups'), driver)
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [root, tag, sha, pipeline, registry, checksum, ...extra] = process.argv.slice(2)
    requireValue(extra.length === 0 && /^[a-f0-9]{64}$/.test(checksum))
    const chunks = [], buffer = Buffer.alloc(65536)
    let size = 0, count
    while ((count = fs.readSync(0, buffer, 0, buffer.length, null)) > 0) {
      size += count;requireValue(size <= 2 * 1024 * 1024);chunks.push(Buffer.from(buffer.subarray(0, count)))
    }
    await receive(root, Buffer.concat(chunks), { tag, sha, pipeline, registry }, checksum)
    console.log('Production release readiness and coordinator completion confirmed.')
  } catch (error) {
    process.stderr.write(error.message === 'FIRST_BOOTSTRAP_REQUIRED'
      ? 'Validated bundle delivered. Manual first bootstrap is required; no production services were started.\n'
      : 'Production release stopped. Preserve release bundle, state, backup and journals; inspect coordinator status.\n')
    process.exitCode = 1
  }
}
