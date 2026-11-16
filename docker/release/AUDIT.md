# Release audit — 2026-10-23

## Evidence and scope

Work started on a clean `feature/task-12-frontend` at
`61b0cf5d41d940c37577f9aa8cfc2911eb14e07a`. No commits, tags, pushes,
production deployment or changes to production configuration were made.
The changes accompanying this report are an uncommitted diff over that SHA.

GitLab pipeline/job URLs, job traces and their actual checkout SHAs were not
available. The unauthenticated project pipelines API returned HTTP 404.
Consequently the two reported GitLab failures cannot be assigned verified
pipeline IDs/SHAs. Local image tags are not evidence of a pipeline's checkout.
Do not treat this audit's local results as successful GitLab pipeline results.

## Contracts traced

- CI builds the application CI image, checks PHP/frontend/release configuration,
  then runs isolated production HTTP integration checks. Publication loads the
  tested image archive, checks its checksum and exact image IDs, refuses existing
  pipeline tags, pushes both images, and only then emits publication evidence.
  The manifest binds SHA/pipeline and unambiguous registry digests.
- Deployment is restricted to protected version-tag pushes and serialized by a
  CI resource group. SSH pins host keys and transports validated JSON on stdin;
  it does not execute scripts from stdin. The server validates the bundle before
  importing it. First bootstrap is explicit.
- `release.sh`, `backup.sh` and `deploy-server.sh` open the same state directory
  on FD 9 and acquire `flock -n -x 9`. Node inherits that descriptor and state
  mutation rechecks its directory identity and lock. The descriptor must remain
  open throughout the operation; the directory must not be replaced.
- Coordinator records a durable quiesce plan, stops writers in order and verifies
  their observed exit state. Backup claims are permanent; completed backups are
  hashed, candidate/revision-bound, restored on isolated resources and rechecked
  before `backup_ready`. A failed existing backup is never silently replaced.
- Continuation freezes configuration, records create/start intents and observed
  container identities, and observes migration exit without rerunning a failed
  migration. Health/dependency/API gates precede atomic current/previous promotion
  and the success receipt. Commit alone is insufficient if cleanup/receipt fails.
- Recovery is explicit. After migrations, rollback only stops writers and records
  `recovery_required`; separate data recovery stages fresh volumes, checks queues
  and promotes verified data. There is no automatic reverse migration or rollback.

The existing startup order is infrastructure → migration → PHP/dependencies →
report-worker → outbox-worker → scheduler → Nginx/API. Nginx is the last service,
so an unhealthy Nginx prevents promotion/success, but workers started earlier are
not automatically stopped. A requirement to keep *all* workers stopped until
Nginx is healthy would change this existing contract and needs a separate design
decision; it must not be inferred from the test name alone.

## Findings matrix

| Cause / classification | Files | Tests / effect | Risk and disposition |
| --- | --- | --- | --- |
| Confirmed fixture defect: last-command shell exec can release the fixture's only lock when the adapter reopens FD 9 | `deploy-ssh.test.mjs`, `deploy-server.sh` | Shared nonblocking lock test; original command reproduced in BusyBox ash | Fixed in existing `61b0cf5`; no production locking change needed |
| Reported new failure: backup setup returned 1 instead of 0, before unhealthy Nginx is injected | `release-run.test.mjs`, `coordinator.mjs`, backup/state modules | Expected 0 is in fixture setup; scenario itself expects 1 | Exact originating exception and CI SHA remain unconfirmed; targeted host/Alpine tests passed, including 80 Alpine repetitions |
| Confirmed common fixture defect: synthetic preflight depends on real wall-clock readings | `coordinator-test-support.mjs`, `backup-test-support.mjs`, `backup.test.mjs` | A full Alpine run failed in another test's setup at `verifyPreflight`, `backup-format.mjs:55`, before quiesce; stable generated timestamps/TTL leave the wall-clock comparisons as the failing contract | Synthetic coordinator and state-evidence fixtures now use a fixed per-process clock; explicit production future/expiry/TTL tests and existing health-timeout probe keep strict temporal checks. The historical GitLab trace is still needed to attribute that job to this same cause |
| Confirmed test diagnostic defect: arbitrary exceptions collapsed to an uninformative message | Five bootstrap/coordinator/backup/continuation/recovery harnesses | Unexpected setup failure cannot identify its contract | Fixed with test-only operation, allowlisted code and source coordinates; arbitrary messages/paths/argv/contents remain private |
| Confirmed fixture isolation defect: daemon-global restore leak assertions see another run's containers/volumes | `backup-docker.test.mjs`, `backup-test-support.mjs` | Real backup test failed alongside isolated bootstrap at its final global leak check | Fixed by applying an additional per-test scope to every helper resource, including coordinator subprocesses; leak assertions remain strict within that scope; foreign sentinel resources exercise isolation |
| Confirmed runtime compatibility defect: staged PostgreSQL inherits a one-second stop timeout | `restore-data.mjs`, `backup-docker.test.mjs` | Standalone real restore repeatedly failed with `RESTORE_POSTGRES_STOP_FAILED`; observer recorded exit 137, OOM=false, StopTimeout=1 | Explicit 30-second grace on creation of the temporary PostgreSQL task; strict exit-zero/OOM checks and durable retry contract retained |
| Confirmed CI observability gap: moving image/package versions and missing SHA/context in release-check output | `.gitlab-ci.yml` | Cross-run comparisons lacked a complete environment fingerprint | Added SHA/pipeline/job, Node/platform/arch, Alpine/BusyBox and free-space output; existing flock/Compose version output retained |
| Coverage limitation: release-checks uses an explicit daemon-free list | `.gitlab-ci.yml`, remaining release tests | Publication-evidence tests run in frontend job; readiness/background/queue-worker and opt-in Docker protocols are not all CI gates | Local audit runs them; automatically enabling additional suites requires a test image with PHP/pcntl/vendor and a deliberately isolated Docker setup |
| Environment hypotheses, not confirmed causes | Backup preflight and filesystem; CI runner | Real disk reserve (64 MiB or more), clock-based preflight expiry, filesystem sync, subprocess failures | Do not bypass these production checks; obtain originating safe diagnostic and runner trace before claiming a fix |

No incorrect unhealthy-Nginx expectation has been confirmed by this audit.
The staged PostgreSQL compatibility correction is separate from the unidentified
GitLab setup exception. The new diagnostics do not constitute a fix for that
exception.

## Environment and validation boundaries

- Host: Node 24.21.0, dash, util-linux flock 2.39.3, Compose 5.1.4.
- Cached `node:24-alpine`: Node 24.21.0, Alpine 3.24.2, BusyBox 1.37.0.
- Offline audit image combines cached Node and Docker CLI images: Alpine 3.24.1,
  BusyBox flock and Compose 5.2.0. Its daemon-free CI command runs without network
  or a Docker socket. This is an Alpine compatibility check, not proof of the
  exact package versions installed in the failing GitLab job.
- Installing the exact CI APK dependencies encountered an unresponsive CDN
  connection, including a retry with proxy forwarding and an APK timeout. This
  does not explain the reported assertion after GitLab had already installed its
  tools and started running tests.
- Real Docker checks use randomly named projects/owner labels, new data volumes,
  no deployment env files, and local immutable images. Application-image protocol
  checks use cached images from pipeline tag `2960523566`; these images do not
  prove current-source image build/HTTP integration/publication.

The temporary PostgreSQL task arguments are journaled. Existing in-progress
recovery tasks must be resumed using their original validated release bundle;
mixing changed task arguments with an older intent deliberately fails closed.
No existing recovery plans were rewritten or migrated by this audit.

## Observed failures and repeats

- Original FD fixture reproduced the reported generic server message in actual
  BusyBox ash. The adapter had acquired the lock; its Node CLI then rejected the
  dummy checksum. No genuine busy-lock error was swallowed in this path.
- Reported unhealthy Nginx test passed initially on the clean checkout on both
  host and Alpine, and 80/80 repetitions passed in cached `node:24-alpine`.
- An intermediate broad run under concurrent audit load completed with
  336 passed, 2 failed, 12 skipped (350 tests). Failures were an unexpectedly early
  backup phase and a 90-second fake-Docker rollback CLI timeout. Both targeted
  repeats passed; the CLI repeat took about 77 seconds. The backup phase test also
  passed 200/200 separate repetitions. Its originating earlier failure is not
  established; assertions now retain safe source diagnostics on phase mismatch.
- An intermediate offline Alpine CI-list run completed with 307 passed, 1 failed,
  0 skipped (308 tests, before the additional scope regression unit was loaded).
  The continuation CLI reached `starting` and exceeded its 90-second timeout.
  This was an observed timeout, not a module import-cycle assertion or Nginx
  setup failure. Timeout limits were not increased.
- After isolating the source copy and serial execution, a complete Alpine run
  completed with 308 passed, 1 failed, 0 skipped (309 tests). Its failure was the
  setup of `committed releases, first installs and pre-backup states are ineligible
  without publishing an intent`. Safe diagnostics identified
  `backupRelease → prepare → persist → verifyPreflight`, specifically the temporal
  validation at `backup-format.mjs:55`. The fixture completed in about 208 ms, not
  the preflight's 15-minute validity period. The receipt is generated by the code,
  with valid ISO timestamps and exactly 900000 ms TTL; it is not external input.
  This confirmed the common real-clock dependency in synthetic protocol tests.
  A separate short Date.now sampling probe observed no backwards readings, so
  this report does not claim a measured correction size, NTP cause or VM bug.
- Initial opt-in backup/runtime/recovery/queue batch completed with 4 passed,
  1 failed: the confirmed daemon-global leak assertion. Subsequent backup probes
  exposed the staged PostgreSQL stop issue. One probe was cancelled by its own
  240-second test timeout. None of these failures is silently counted as passing.
- Full local bootstrap plus actual application DB/S3 recovery and repeats passed
  (1 passed, 0 failed/skipped, about 930 seconds). Durable state and container
  progression were inspected during execution; this was not an abandoned hang.
- Image background/queue signal tests passed (19 passed, 0 failed/skipped).
- A stable broad run before the staged grace correction completed with
  339 passed, 0 failed, 12 skipped (351 tests). Final post-correction verification
  is recorded below separately.
- After the grace correction, the real backup/restore test passed (1 passed,
  0 failed/skipped, about 166 seconds), including data/ownership checks, repeated
  recovery, foreign sentinels and coordinator backup/restore. The stop observer
  recorded exit 0, OOM=false, StopTimeout=30 instead of the earlier exit 137 with
  StopTimeout=1. The observer only records selected state fields after `stop`.
- Four key Alpine scenarios passed on an extracted source copy with
  `--test-concurrency=1`: shared lock, unhealthy Nginx, rollback CLI and
  continuation CLI (4 passed, 0 failed/skipped). Rollback took about 35 seconds;
  continuation about 64 seconds. The earlier read-only WSL bind-mount attempt
  also ran files concurrently and hit two CLI timeouts. This supports an
  environment/execution-cost sensitivity; it does not isolate filesystem cost
  from concurrency or establish the originating GitLab exception.
- After adding the fixed synthetic clock, targeted diagnostics/scope/clock tests
  passed (19 passed, 0 failed/skipped). Regression tests exercise backwards and
  forwards clock changes; the production validator still rejects future, expired
  and altered-TTL receipts. The existing health-timeout test explicitly advances
  Date.now after constructing the fixture and remains a real timeout-contract test.

## Changed files

- `restore-data.mjs`: explicit graceful-stop policy for the staged PostgreSQL task.
- `backup-docker.test.mjs`, `backup-test-support.mjs`, `backup.test.mjs`:
  per-run helper labels, strict scoped leak assertions, foreign-resource
  sentinels and forwarding/failure regression coverage; real stop-grace assertion.
- `coordinator-test-support.mjs`, `backup-test-support.mjs`, `backup.test.mjs`:
  deterministic clock for synthetic preflight and state evidence, with production
  temporal rejection regression coverage. Actual Docker adapters retain real time.
- `release-test-diagnostics.mjs`, `release-test-diagnostics.test.mjs`:
  test-only safe diagnostics and privacy regression tests.
- `bootstrap.test.mjs`, `coordinator.test.mjs`, `coordinator-backup.test.mjs`,
  `release-run.test.mjs`, `recovery.test.mjs`: use the diagnostic contract;
  retain diagnostics on unexpected backup phase assertions.
- `../../.gitlab-ci.yml`: release-check metadata and diagnostic regression suite.
- `AUDIT.md`: this evidence, cause/risk matrix and validation limitations.

## Reproduction commands

The commands are run from the repository root. Test subprocesses required a run
outside the workspace sandbox because its restrictions caused `spawnSync sh
EPERM`. That restriction is distinct from release exit codes.

```sh
# Initial reported target, then its 80 repetitions in cached node:24-alpine.
node --test --test-reporter=tap \
  --test-name-pattern='unhealthy nginx blocks success and downstream writers' \
  docker/release/release-run.test.mjs

# Final diagnostic privacy, backup-scope and clock tests: 19 passed, 0 failed/skipped.
node --test --test-reporter=tap \
  docker/release/release-test-diagnostics.test.mjs docker/release/backup.test.mjs

# Full default release suite; results of the final run are recorded below.
node --test --test-concurrency=1 --test-reporter=tap docker/release/*.test.mjs

# Initial real Docker batch: 4 passed, 1 failed before scope correction.
BACKUP_DOCKER_TEST=1 RELEASE_RUNTIME_DOCKER_TEST=1 RESTORE_QUEUES_DOCKER_TEST=1 \
  node --test --test-concurrency=1 --test-reporter=tap \
  docker/release/backup-docker.test.mjs docker/release/release-runtime-docker.test.mjs \
  docker/release/recovery-docker.test.mjs docker/release/restore-queues-docker.test.mjs

# Post-correction real backup test. NODE_OPTIONS added a local state-only observer.
BACKUP_DOCKER_TEST=1 \
  NODE_OPTIONS=--import=/tmp/pizza-release-audit-env/stop-observation.mjs \
  node --test --test-reporter=tap docker/release/backup-docker.test.mjs

# The exact locally cached immutable application image used for protocol tests.
BOOTSTRAP_DOCKER_TEST=1 RECOVERY_APP_DOCKER_TEST=1 \
  BOOTSTRAP_TEST_PHP_IMAGE=registry.gitlab.com/jihannaxz1/pizza-backend/php@sha256:ddc6b7ba721f7cfd934aede5da93e1f7d157f37bffa0d96ba9a8654be35272ba \
  BOOTSTRAP_TEST_NGINX_IMAGE=registry.gitlab.com/jihannaxz1/pizza-backend/nginx@sha256:5102edff906c921f018d4f6c5ab7ec7f473a1a5efd278e8f6e9f2c1cab5996f7 \
  node --test --test-reporter=tap docker/release/bootstrap-docker.test.mjs

BACKGROUND_TEST_IMAGE=sha256:ddc6b7ba721f7cfd934aede5da93e1f7d157f37bffa0d96ba9a8654be35272ba \
  QUEUE_WORKER_TEST_IMAGE=sha256:ddc6b7ba721f7cfd934aede5da93e1f7d157f37bffa0d96ba9a8654be35272ba \
  node --test --test-concurrency=1 --test-reporter=tap \
  docker/release/background.test.mjs docker/release/queue-worker-image.test.mjs

for file in docker/release/*.mjs; do node --check "$file" || exit; done
for file in docker/release/*.sh docker/ci/*.sh docker/php/entrypoint*.sh; do sh -n "$file" || exit; done
for file in docker/release/*.php docker/php/scheduler.php; do php -l "$file" || exit; done
git diff --check
```

The final Alpine run executes the last `release-checks.script` entry parsed from
the current YAML. Current tracked working files plus the new diagnostic modules
were copied via a local tar archive into the offline audit image. SHA256 of the
CI file and every release `.mjs`/`.sh` is verified before running tests. No socket
or network is mounted. This avoids substituting a second handwritten CI test list.

Local validation logs are under `/tmp/pizza-audit-*`; source input hashes are in
`/tmp/pizza-audit-final-inputs.sha256`. YAML was parsed with PyYAML and every
release-check script item was verified to be a string. GitLab server-side CI lint,
PHP application tests/static analysis, image publication and deployment were not
run as part of these Node/shell/test-fixture changes.

The broad default suite skips 12 opt-in cases: backup (1), bootstrap (1), recovery
(1), runtime/worker health (2), RabbitMQ queue protocol (1), image queue shutdown
(3), and image-only background shutdown/deadline cases (3). Their switches are
`BACKUP_DOCKER_TEST`, `BOOTSTRAP_DOCKER_TEST`, `RECOVERY_APP_DOCKER_TEST`,
`RELEASE_RUNTIME_DOCKER_TEST`, `RESTORE_QUEUES_DOCKER_TEST`,
`QUEUE_WORKER_TEST_IMAGE`, and `BACKGROUND_TEST_IMAGE`. Missing opt-in variables
are not evidence that Docker is unavailable.

## Final verification

Both final broad runs used the same SHA256-verified working-tree snapshot over
`61b0cf5`, including staged grace, scoped cleanup, diagnostics and synthetic
clock changes. Both completed naturally with exit status 0.

| Check | Passed | Failed | Skipped | Log |
| --- | ---: | ---: | ---: | --- |
| Full default host suite, 354 tests | 342 | 0 | 12 | `/tmp/pizza-audit-final-clock-host.tap` |
| Actual CI release-list in offline Alpine copy, 312 tests | 312 | 0 | 0 | `/tmp/pizza-audit-final-clock-alpine.log` |
| Final targeted diagnostic/scope/clock regressions | 19 | 0 | 0 | `/tmp/pizza-audit-final-target.tap` |
| Real backup/restore after staged-grace correction | 1 | 0 | 0 | `/tmp/pizza-audit-backup-grace.tap` |
| Real bootstrap plus DB/S3 recovery and repeats | 1 | 0 | 0 | `/tmp/pizza-audit-bootstrap.tap` |
| Image background/queue shutdown protocols | 19 | 0 | 0 | `/tmp/pizza-audit-image-workers.tap` |

The actual final Alpine invocation was:

```sh
docker run --rm -i --network none --entrypoint sh \
  --mount type=bind,src=/tmp/pizza-release-audit-env/release-checks.sh,dst=/release-checks.sh,readonly \
  --mount type=bind,src=/tmp/pizza-audit-final-inputs.sha256,dst=/audit-inputs.sha256,readonly \
  -w /workspace pizza-release-audit-env:61b0cf5 \
  -ec 'tar -xf - -C /workspace; sha256sum -c /audit-inputs.sha256 > /dev/null; sh /release-checks.sh' \
  < /tmp/pizza-release-audit-env/source.tar
```

Node and shell syntax checks, PHP helper lint, YAML parsing and
`git diff --check` passed. No unrelated tracked files were changed. No tests or
safety assertions were removed, no test deadline was raised to hide a slow test,
and production preflight time validation was not relaxed. The 30-second grace is
an explicit policy for a newly created isolated staging database, with strict
post-stop verification retained.

The patch is ready for another pipeline. Historical pipeline attribution still
requires GitLab job traces/checkout SHAs; the successful local Alpine run is not
an assertion about an unobserved GitLab job or its exact APK versions.

## Follow-up needed

Obtain both failed jobs' pipeline IDs, checkout SHAs, image digests, complete
assertion locations and job traces. Match the historical setup failure to the
confirmed local preflight time-validation path before claiming a verified cause
for that specific GitLab job. The staged PostgreSQL and leak-isolation corrections
are independently confirmed defects, not explanations of the Nginx failure.
