import { ReleaseRuntime } from './release-runtime.mjs'

export class FakeRestoreData extends ReleaseRuntime {
  restore() {
    this.check()
    this.record('restore-intent', { id: this.plan.id })
    for (const name of ['database', 'files']) {
      const value = this.driver.read()
      value.restored ??= {}
      value.restored[this.plan.id] ??= {}
      this.driver.write(value)
      if (!value.restored[this.plan.id][name]) {
        this.driver.hit('restore-' + name)
        if (this.driver.read().data_exit) {
          this.record('failed', { task: name, exit_code: 1 })
          throw new Error('RESTORE_TASK_FAILED_USE_NEW_ATTEMPT')
        }
        const fresh = this.driver.read()
        fresh.restored[this.plan.id][name] = true
        this.driver.write(fresh)
        this.driver.hit('after-restore-' + name)
      }
      this.record('completed-' + name, { id: this.plan.id })
    }
    this.check()
    this.record('data-restored', { id: this.plan.id })
    return this.plan.volumes
  }
}
