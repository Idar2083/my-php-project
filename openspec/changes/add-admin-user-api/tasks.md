# Tasks

## 1. User listing interface

- [x] 1.1 Add Auth Presentation Requests/IndexUsersRequest.php and Resources/AdminUserResource.php with page >= 1, per_page 1..100/default 20 and explicit id/name/email/role/created_at fields; verify list Feature tests reject invalid input and sensitive/extra fields.
- [x] 1.2 Add Presentation/Controllers/AdminUserController.php index and GET /api/admin/users in app/routes/api.php under existing auth:api/admin middleware; query safe columns ordered by id and return paginated Resource collection; verify 401, 403, default/custom/max pages, total metadata, stable sorting and empty page in app/tests/Feature/Auth/AdminUserListTest.php.
- [x] 1.3 Keep the new endpoint contract documented in this change's specs/design; verify documented pagination/fields agree with exact response assertions.

## 2. Role mutation interface and invariants

- [x] 2.1 Add Auth Presentation/Requests/UpdateUserRoleRequest.php following Order's Enum rule and typed accessor; add PATCH /api/admin/users/{userId}/role with numeric route constraint and controller delegation; verify auth-before-validation, invalid/missing/wrong-type role 422 and valid unknown target 404 in app/tests/Feature/Auth/UpdateUserRoleTest.php.
- [x] 2.2 Add Auth Application/Handlers/ChangeUserRoleHandler.php using DB::transaction, deduplicated actor/target primary-key SELECT FOR UPDATE queries in ascending ID order; verify effective runtime isolation is READ COMMITTED and fresh models are used for authorization, with no advisory lock or shared lock abstraction.
- [x] 2.3 Reload and authorize actor after obtaining lock; enforce last-admin conflict before self-demotion conflict; allow same-role no-op; reuse TranslatableException and add messages in app/lang/en/api.php and app/lang/ru/api.php; verify 200 promotion/demotion/no-op, 409 self and last-admin, localized errors, rollback/no mutation and safe Resource responses in role Feature tests.
- [x] 2.4 Verify an existing JWT on a fresh request respects promotion/demotion and original Auth endpoints remain compatible; run Auth Feature tests including existing AuthTest, without changing AuthController, User, UserRole, AdminMiddleware or JWT configuration.

## 3. Real PostgreSQL concurrency

- [x] 3.1 Add app/tests/Integration/Auth/ChangeUserRoleHandlerIntegrationTest.php for reauthorization of stale actor, transaction rollback and direct handler invariant behavior; verify against real PostgreSQL and assert persisted roles after rejected operations.
- [x] 3.2 Add app/tests/Integration/Auth/UserRoleConcurrencyTest.php and app/tests/Support/concurrency_user_role_worker.php using DatabaseMigrations, configured test connection and independent Symfony Process workers; use a parent-held participant row lock and pg_blocking_pids/pg_stat_activity synchronization with bounded timeouts; workers must issue HTTP-kernel PATCH requests so actual 200/403 responses are asserted; verify no production database configuration is used and no password/secret is printed or embedded in source.
- [x] 3.3 Test cross-demotion with two admins, same-target identical/conflicting role assignments and independent mutations: assert one cross-demotion succeeds, the other loses authorization, final admin count is one, overlapping role mutations wait on participant row locks and locks release after rollback; both authorized same-target requests succeed, with an idempotent no-op or last serialized assignment respectively; verify both worker outcomes and database state, not only process exit codes.

## 4. Final review and quality pipeline

- [x] 4.1 Run relevant checks first: docker compose exec php ./vendor/bin/phpunit tests/Feature/Auth; then docker compose exec php ./vendor/bin/phpunit tests/Integration/Auth; verify results or record exact command/error if environment prevents execution.
- [x] 4.2 Run docker compose exec php ./vendor/bin/phpunit and docker compose exec php ./vendor/bin/phpunit tests/Unit; verify all configured Feature/Integration and explicitly excluded Unit tests, reporting pre-existing/environment failures accurately.
- [x] 4.3 Run docker compose exec php ./vendor/bin/phpstan analyse app routes config database; docker compose exec php ./vendor/bin/php-cs-fixer fix --dry-run --diff; docker compose exec php ./vendor/bin/rector process --dry-run; docker compose exec php composer validate --strict; report each result and exact failure reason without installing dependencies.
- [x] 4.4 Perform a separate thermo-nuclear-code-quality-review of the implementation diff and architecture review with codebase-design/improve-codebase-architecture/domain-modeling; verify transaction locality, minimal interface, no redundant layers/DTOs, explicit safe fields, stale actor handling and deterministic tests; fix only task-scoped findings, rerun affected checks.
- [x] 4.5 Inspect final git diff/status for unrelated edits and secrets; validate OpenSpec change; report files, tests, review results and limitations without committing or archiving automatically.

## Workflow follow-up

- Implementation may begin only after the user explicitly approves this plan; no task is complete merely because planning artifacts exist.
- Archive/sync the completed change only when requested after implementation and review.

## Verification status

Runtime verification completed in Docker on 2026-10-07. All six Compose services were running and healthy; no startup was required.

Two test-environment issues were corrected without changing application implementation: PHPUnit now forces APP_ENV=testing in $_SERVER as well as the process environment, overriding Compose's APP_ENV=local; the existing-JWT Feature test clears the JWT singleton token alongside cached guards between simulated fresh requests.

Passing checks:
- Auth Feature: 43 tests, 229 assertions.
- Auth Integration: 14 tests, 177 assertions, including PostgreSQL READ COMMITTED and independent concurrent HTTP workers.
- Full configured PHPUnit suite: 119 tests, 634 assertions.
- Explicit Unit suite: 2 tests, 11 assertions.
- Container PHPStan (`app routes config database`), PHP-CS-Fixer dry-run, Rector dry-run, and Composer validation with --strict.
- Development/production Compose configuration validation, git diff --check, and OpenSpec strict validation.

An initial full-suite/Unit attempt overlapped on the same test database because the full-suite command returned a running session; migration collisions resulted. Both suites were then rerun strictly sequentially and passed. No application fix was needed for those collisions.

The earlier separate architecture/thermo-nuclear review remains complete. Its scoped overflow route-ID and same-target concurrency assertion fixes passed the runtime checks above. No dependencies, migrations, Auth/JWT contract changes, commits or archive operations were performed.
