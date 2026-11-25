import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

export const graceSeconds = 10 // Current Compose default; no production timeout is changed.

export async function exerciseWorker(child, signal, sendSignal, { pidOne = false } = {}) {
  let output = ''
  let errors = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { errors += chunk })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  async function waitFor(pattern, timeout) {
    const deadline = Date.now() + timeout
    while (!pattern.test(output)) {
      assert.equal(child.exitCode, null, 'Fixture exited before the expected event')
      assert.equal(child.signalCode, null, 'Fixture was terminated before the expected event')
      assert.ok(Date.now() < deadline, 'Fixture event timed out')
      await delay(20)
    }
  }
  try {
    await waitFor(/READY pid=\d+\n/, 10000)
    if (pidOne) assert.match(output, /READY pid=1\n/)
    // The first job remains in progress until the completion gate is released.
    await delay(1000)
    const started = Date.now()
    await sendSignal()
    await waitFor(new RegExp(`SIGNAL ${signal}\n`), 2000)
    assert.doesNotMatch(output, /FINISHED|SECOND_STARTED/)
    await delay(500)
    child.stdin.end('finish\n')
    const result = await Promise.race([
      exited,
      delay(graceSeconds * 1000, undefined, { ref: false }).then(() => { throw new Error('Worker exceeded the test grace period') }),
    ])
    assert.deepEqual(result, { code: 0, signal: null })
    assert.ok(Date.now() - started < graceSeconds * 1000)
    assert.match(output, /FINISHED\nACKNOWLEDGED\nSTOPPED interrupted\nRESULT remaining=1 pops=1\n/)
    assert.doesNotMatch(output, /SECOND_STARTED/)
    assert.equal(errors, '')
  } finally {
    child.stdin.destroy()
  }
}
