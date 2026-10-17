import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { create, save } from './manifest.mjs'

// Evidence is emitted only after both pushes by publish-production. Match the
// registry references to the exact local image IDs verified before publication.
export function publishedManifest(environment, ids, inspections) {
  const expected = ids.trim().split(/\r?\n/)
  if (expected.length !== 2 || !expected.every(id => /^sha256:[a-f0-9]{64}$/.test(id))) throw new Error('Invalid image IDs')
  const references = {}
  for (const [index, service] of ['php', 'nginx'].entries()) {
    const evidence = inspections[index]
    if (!evidence || evidence.id !== expected[index] || !Array.isArray(evidence.digests) ||
        !evidence.digests.every(value => typeof value === 'string')) throw new Error('Invalid publication evidence')
    const prefix = `${environment.CI_REGISTRY_IMAGE}/${service}@`
    const matches = [...new Set(evidence.digests.filter(value => value.startsWith(prefix)))]
    if (matches.length !== 1) throw new Error('Missing or ambiguous registry digest')
    references[`${service.toUpperCase()}_IMAGE`] = matches[0]
  }
  return create({ CI_COMMIT_SHA: environment.CI_COMMIT_SHA, CI_PIPELINE_ID: environment.CI_PIPELINE_ID, ...references })
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [directory, output, ...extra] = process.argv.slice(2)
    if (!directory || !output || extra.length) throw new Error('Invalid arguments')
    const manifest = publishedManifest(process.env,
      readFileSync(join(directory, 'production-images.ids'), 'utf8'),
      ['php', 'nginx'].map(service => JSON.parse(readFileSync(join(directory, `published-${service}.json`), 'utf8'))))
    save(output, manifest)
  } catch {
    process.stderr.write('Published release manifest failed: verify image evidence, CI identifiers and output-file existence.\n')
    process.exitCode = 1
  }
}
