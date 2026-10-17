import { isDeepStrictEqual } from 'node:util'
import { DockerBackup } from './backup-docker.mjs'
import { checkCompose } from './state.mjs'
import { ensure } from './backup-format.mjs'
import { validate as validateManifest } from './manifest.mjs'

// Ingress first; MinIO last, after all of its application writers have exited.
export const writerOrder = ['nginx', 'report-scheduler', 'outbox-worker', 'report-worker', 'php', 'minio-init', 'minio']

export class DockerCoordinator {
  constructor(settings) {
    this.backup = new DockerBackup(settings)
    // Use the same local daemon for image acquisition, inventory and stopping.
    // Registry authentication remains in Docker config, never in argv or logs.
    if (process.env.DOCKER_CONFIG) this.backup.env.DOCKER_CONFIG = process.env.DOCKER_CONFIG
  }
  check(state, manifest, bundle, runtime) {
    return checkCompose(state, manifest, bundle, runtime, this.backup.env)
  }
  image(reference, platform) {
    const image = JSON.parse(this.backup.run(['image', 'inspect', reference]))[0]
    ensure(/^sha256:[a-f0-9]{64}$/.test(image.Id) && Array.isArray(image.RepoDigests) && image.RepoDigests.includes(reference), 'RELEASE_IMAGE_NOT_AVAILABLE')
    if (platform) ensure(image.Os === platform.Os && image.Architecture === platform.Arch, 'RELEASE_IMAGE_PLATFORM_MISMATCH')
    return image.Id
  }
  images(manifest, pull = false) {
    validateManifest(manifest)
    const platform = JSON.parse(this.backup.run(['version', '--format', '{{json .Server}}']))
    ensure(platform.Os === 'linux' && typeof platform.Arch === 'string' && platform.Arch.length > 0, 'UNSUPPORTED_DOCKER_PLATFORM')
    for (const reference of Object.values(manifest.images)) {
      if (pull) this.backup.run(['pull', '--quiet', reference], { discardOutput: true })
      this.image(reference, platform)
    }
  }
  writer(container, project) {
    const labels = container.Config.Labels
    ensure(labels['com.docker.compose.project'] === project && writerOrder.includes(labels['com.docker.compose.service']))
    ensure(/^[a-f0-9]{64}$/.test(container.Id) && /^sha256:[a-f0-9]{64}$/.test(container.Image))
    ensure(typeof container.State.StartedAt === 'string' && container.State.StartedAt.length > 0)
    ensure(!container.State.Paused && !container.State.Restarting && !container.State.Dead && !container.State.OOMKilled, 'WRITER_UNSAFE')
    ensure(container.State.Running || (['exited', 'created'].includes(container.State.Status) && container.State.ExitCode === 0), 'WRITER_UNSAFE')
    return { id: container.Id, service: labels['com.docker.compose.service'], image: container.Image, started_at: container.State.StartedAt }
  }
  snapshot(state) {
    const inventory = this.backup.inventory(false)
    const writers = inventory.map(([id]) => this.writer(this.backup.inspect(id), state.project))
    ensure(new Set(writers.map(item => item.service)).size === writers.length, 'DUPLICATE_WRITER')
    if (state.current) {
      const images = { php: this.image(state.current.images.php), nginx: this.image(state.current.images.nginx) }
      for (const writer of writers) {
        if (['php', 'report-worker', 'outbox-worker', 'report-scheduler'].includes(writer.service)) ensure(writer.image === images.php, 'SOURCE_RELEASE_MISMATCH')
        if (writer.service === 'nginx') ensure(writer.image === images.nginx, 'SOURCE_RELEASE_MISMATCH')
      }
    }
    return writers.sort((a, b) => writerOrder.indexOf(a.service) - writerOrder.indexOf(b.service))
  }
  stop(writer, project) {
    const before = this.backup.inspect(writer.id)
    ensure(isDeepStrictEqual(this.writer(before, project), writer), 'WRITER_CHANGED')
    // Docker uses the container's configured StopSignal and StopTimeout, including
    // Compose's 70s grace period. The stop command's success alone is insufficient.
    if (before.State.Running) this.backup.run(['stop', writer.id], { discardOutput: true })
    const after = this.backup.inspect(writer.id)
    ensure(isDeepStrictEqual(this.writer(after, project), writer) && !after.State.Running, 'WRITER_NOT_STOPPED')
  }
  quiesced() { this.backup.inventory(true) }
}
