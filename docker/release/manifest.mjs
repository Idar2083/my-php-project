import { linkSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const sha = /^[a-f0-9]{40}$/
const component = '[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*'
const image = new RegExp(`^([a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?/${component}(?:/${component})*)/(php|nginx)@sha256:[a-f0-9]{64}$`)

function keys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).sort().join(',') !== [...expected].sort().join(',')) {
    throw new Error('Unexpected manifest fields')
  }
}

export function validate(manifest) {
  keys(manifest, ['schema_version', 'git_sha', 'pipeline_id', 'deployment_config', 'images'])
  keys(manifest.deployment_config, ['version', 'git_sha'])
  keys(manifest.images, ['php', 'nginx'])
  if (manifest.schema_version !== 1 || manifest.deployment_config.version !== 1 ||
      typeof manifest.git_sha !== 'string' || manifest.git_sha.length !== 40 || !sha.test(manifest.git_sha) ||
      manifest.deployment_config.git_sha !== manifest.git_sha ||
      typeof manifest.pipeline_id !== 'string' || manifest.pipeline_id.trim() !== manifest.pipeline_id ||
      !/^[1-9][0-9]*$/.test(manifest.pipeline_id)) {
    throw new Error('Invalid manifest version or source identifiers')
  }
  let repository
  for (const service of ['php', 'nginx']) {
    const reference = manifest.images[service]
    const match = typeof reference === 'string' && image.exec(reference)
    if (!match || match[0] !== reference || match[2] !== service || (repository && repository !== match[1])) {
      throw new Error('Expected PHP and Nginx digest references from the same registry project')
    }
    repository = match[1]
  }
  return manifest
}

export function create(environment) {
  return validate({
    schema_version: 1,
    git_sha: environment.CI_COMMIT_SHA,
    pipeline_id: environment.CI_PIPELINE_ID,
    deployment_config: { version: 1, git_sha: environment.CI_COMMIT_SHA },
    images: { php: environment.PHP_IMAGE, nginx: environment.NGINX_IMAGE },
  })
}

export function composeEnvironment(manifest) {
  validate(manifest)
  return `PHP_IMAGE=${manifest.images.php}\nNGINX_IMAGE=${manifest.images.nginx}\n`
}

export function save(path, manifest) {
  validate(manifest)
  // Exclusive creation: even a retry must never overwrite an existing release.
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
}

export function exportEnvironment(path, manifest) {
  const contents = composeEnvironment(manifest)
  // Same filesystem as the destination: link publishes complete bytes atomically
  // and fails if any entry (including a symlink) already occupies the final path.
  const directory = mkdtempSync(join(dirname(path), '.pizza-release-env-'))
  try {
    const temporary = join(directory, 'release.env')
    writeFileSync(temporary, contents, { flag: 'wx', mode: 0o600, flush: true })
    linkSync(temporary, path)
  } finally {
    rmSync(directory, { recursive: true })
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [command, file, ...extra] = process.argv.slice(2)
    if (!file || !['create', 'validate', 'env', 'export-env'].includes(command) ||
        (command === 'export-env' ? extra.length !== 1 || !extra[0] : extra.length !== 0)) {
      throw new Error('Invalid command arguments')
    }
    if (command === 'create') {
      save(file, create(process.env))
    } else {
      const manifest = validate(JSON.parse(readFileSync(file, 'utf8')))
      if (command === 'env') process.stdout.write(composeEnvironment(manifest))
      if (command === 'export-env') exportEnvironment(extra[0], manifest)
    }
  } catch {
    // Never echo input, environment, file contents, paths or parser exceptions.
    process.stderr.write('Release manifest command failed: check usage, fields and output-file existence.\n')
    process.exitCode = 1
  }
}
