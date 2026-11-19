const messages = [
  [/health check exceeded timeout|timed? out|timeout exceeded/i, 'timeout'],
  [/invalid challenge reply|authentication failed|access[_ ]refused/i, 'authentication_failed'],
  [/erlang cookie|\.erlang\.cookie/i, 'erlang_cookie'],
  [/epmd|nodedown|unable to connect to node/i, 'node_unreachable'],
  [/boot failed|failed to start/i, 'boot_failed'],
  [/out of memory|cannot allocate memory|oom[_ ]kill/i, 'out_of_memory'],
  [/failed to create .*thread|resource temporarily unavailable/i, 'thread_creation_failed'],
  [/no space left on device|enospc/i, 'disk_full'],
  [/permission denied|eacces/i, 'permission_denied'],
  [/ping succeeded|server startup complete/i, 'ready'],
]

function signals(text) {
  // Free-form broker and probe output can include credentials or Erlang cookies.
  return messages.filter(([pattern]) => pattern.test(text)).map(([, label]) => label)
}

function safeState(value, choices) {
  return choices.includes(value) ? value : null
}

function safeTime(value) {
  return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?(?:Z|[+-]\d\d:\d\d)$/.test(value) ? value : null
}

function safeNumber(value) {
  return Number.isSafeInteger(value) ? value : null
}

function diagnoseRabbitMq(composeCapture, dockerCapture, report) {
  try {
    const id = composeCapture('ps', '--all', '--quiet', 'rabbitmq')
    if (!/^[a-f0-9]{64}$/.test(id)) {
      report('RabbitMQ diagnostics unavailable: no unique Compose container.')
      return
    }

    try {
      const [image, restartCount, state] = dockerCapture('inspect', '--format',
        '{{json .Image}}\n{{json .RestartCount}}\n{{json .State}}', id).split('\n').map(line => JSON.parse(line))
      const probes = (state.Health?.Log ?? []).slice(-5).map(entry => ({
        start: safeTime(entry.Start), end: safeTime(entry.End), exitCode: safeNumber(entry.ExitCode),
        signals: signals(entry.Output ?? ''),
      }))
      report('RabbitMQ state ' + JSON.stringify({
        status: safeState(state.Status, ['created', 'running', 'paused', 'restarting', 'removing', 'exited', 'dead']),
        exitCode: safeNumber(state.ExitCode), oomKilled: state.OOMKilled === true, restartCount: safeNumber(restartCount),
        imageId: typeof image === 'string' && /^sha256:[a-f0-9]{64}$/.test(image) ? image : null,
        health: safeState(state.Health?.Status, ['starting', 'healthy', 'unhealthy', 'none']),
        failingStreak: safeNumber(state.Health?.FailingStreak), probes,
      }))
    } catch {
      report('RabbitMQ state unavailable.')
    }

    try {
      const logs = composeCapture('logs', '--no-color', '--tail', '40', 'rabbitmq').split('\n').slice(-40)
      report('RabbitMQ log summary ' + JSON.stringify({
        lines: logs.filter(Boolean).length, signals: signals(logs.join('\n')),
      }))
    } catch {
      report('RabbitMQ log summary unavailable.')
    }
  } catch {
    report('RabbitMQ diagnostics unavailable.')
  }
}

export function startServices(start, composeCapture, dockerCapture, report = console.error) {
  try {
    start()
  } catch (error) {
    try {
      diagnoseRabbitMq(composeCapture, dockerCapture, report)
    } finally {
      throw error
    }
  }
}
