# Design

## Context

See proposal.md for motivation. Confirmed code locations:

- Auth `Domain/Models/User.php`: Eloquent Authenticatable, role enum cast, hidden password/remember_token, empty JWT custom claims.
- Auth `Domain/Enums/UserRole.php`: ADMIN/admin and USER/user. Migration stores a string defaulting to user; no enum constraint is needed for HTTP validation.
- `config/auth.php`: api JWT guard and Eloquent User provider. Installed `tymon/jwt-auth` JWTGuard retrieves the user by subject ID; role is not a token claim. The guard caches the model during a request, so mutation authorization must reload it.
- Auth `Presentation/Middleware/AdminMiddleware.php` and `routes/api.php`: existing auth:api/admin group protects Catalog writes, Order status and Report endpoints. No Policy/Gate mechanism was found in application code.
- Auth `Application/Handlers/RegisterUserHandler.php`: direct Eloquent and DB::transaction, primitive arguments, no registration DTO or repository for users.
- Order status Request uses `Illuminate\Validation\Rules\Enum` and a typed accessor. Order/Catalog Resources explicitly map fields. Common ApiRequest authorizes true because routes enforce access.
- Shared TranslatableException already supports translated 409 conflicts; bootstrap renders it as JSON. Reuse it without adding domain logic to Shared.
- PostgreSQL 15 is configured in Docker. Feature/Integration suites use PostgreSQL; Unit is not included by phpunit.xml. Existing Cart concurrency tests use DatabaseMigrations and separate Symfony Process workers; regular tests use RefreshDatabase and JWTAuth::fromUser.

## Goals / Non-Goals

**Goals:** Concentrate role mutation invariants in one Auth handler with a small interface, keep transport validation/serialization in Presentation, and test HTTP contracts plus real transaction interleaving.

**Non-Goals:** New Admin module, Policy/Gate, repository, generic lock manager, DTOs for one enum, migration, dependencies, JWT lifecycle changes, deleting users, administrator bootstrap, auditing infrastructure, or unrelated refactoring.

## Decisions

### Routes and presentation

Add GET `/api/admin/users` and PATCH `/api/admin/users/{userId}/role` inside the existing auth:api/admin group, with a numeric target route constraint. Use a new AdminUserController, IndexUsersRequest, UpdateUserRoleRequest and AdminUserResource in Auth Presentation.

Index request validates positive page and per_page 1..100 (default 20). Reject oversize input with 422 rather than silently clamping. Explicit orderBy('id') gives deterministic ordering on unchanged data. Return a paginated Resource collection using Laravel's data/links/meta envelope; offsets do not provide a snapshot across concurrent inserts. Query only the five permitted fields. Keep this single read query in index: a pass-through read handler would add no useful depth. The mutation delegates to an Application handler.

Resource explicitly maps id/name/email/role value/created_at. Use the same allowlist for list and mutation; never rely solely on model Hidden metadata or serialize the full model. Update request follows UpdateOrderStatusRequest's enum rule and typed accessor. Validation precedes target lookup, so invalid role plus missing numeric target returns 422; valid role plus missing target returns 404.

### Role business rules

Use ChangeUserRoleHandler::handle(actorId, userId, UserRole): User. Accept actor ID rather than trusting an already-loaded User. Proposed decisions, subject to approval of this plan: actual self-demotion is forbidden (409); assigning the existing role is idempotent (200). If target is the final admin and requested role is user, check last-admin protection first (409 distinct translated message), then check self-demotion. This makes both protections explicit and testable. Other-admin demotion is allowed. No admin can be bootstrapped through an admin-only endpoint when the database has zero admins.

### Row locking: minimum sufficient protocol

Use DB::transaction and the existing Eloquent lockForUpdate mechanism in ChangeUserRoleHandler. Deduplicate actorId/userId, sort the IDs numerically, and issue one primary-key SELECT FOR UPDATE per ID in that order. Keep the returned freshly loaded models; never authorize using the middleware's cached User. At READ COMMITTED an awaited row lock returns the updated row. An absent actor or a currently non-admin actor raises AuthorizationException (403); a missing target with an authorized actor yields 404. Acquire all participant locks before checks and writes.

Concrete SQL shape, with bound IDs, executed in the same transaction:

```sql
BEGIN;
SELECT * FROM users WHERE id = :smaller_id FOR UPDATE;
SELECT * FROM users WHERE id = :larger_id FOR UPDATE;
-- Second SELECT omitted when actor and target are the same user.
-- Authorize fresh actor, resolve target, check invariants, update only role.
COMMIT;
```

A SELECT FOR UPDATE on the target alone is insufficient: requests A->B and B->A can lock distinct targets, trust stale middleware actors and demote both admins. Locking both actor and target, always in ascending ID order, is sufficient with the approved no-self-demotion rule. Proof: every successful admin-to-user transition has a distinct actor who is currently admin and whose locked row cannot be demoted/deleted until this transaction ends. Thus that operation always leaves at least its actor as admin. Self-demotion is rejected. Concurrent transitions follow the same rule; a previously demoted actor fails fresh authorization. The global admin count is not the concurrency protection; the locked surviving actor is.

Check the last-admin case explicitly before self-demotion, using current role and whether another admin exists. For distinct actor/target the authorized locked actor proves another admin exists; for a self-target use an existence query for other admins to select the last-admin versus self-demotion message. Both self-target outcomes reject the mutation, so concurrent changes in the other-admin set cannot invalidate safety. This count/existence check is a current READ COMMITTED observation, not a database-wide predicate lock.

Comparison of options:

- Target row only: inadequate with stale actor authorization.
- Actor and target rows, ascending ID order: selected; established project pattern, at most two row locks, no global key, no new layer, unrelated pairs can execute concurrently.
- Global advisory lock plus actor/target rows: also correct, but redundant for these rules and serializes unrelated operations. A concrete alternative would be `SELECT pg_advisory_xact_lock(1346984513, 1)`; the first literal is hex 0x50495A41 (a documented application namespace), second is the role-operation slot. Fixed int32 parameters, no hash/user-specific key and no secret. This candidate is NOT used or reserved. It would add a cooperative hidden namespace requirement that normal SQL writers do not obey.
- Lock every admin or the users table: unnecessary broader contention; table locks interfere with unrelated writes. New singleton lock row: unnecessary migration.

All future administrative role mutation entrypoints must call this handler or explicitly use the same actor/target locking, fresh authorization and no-self-demotion rules. Current registration creates an ordinary user and does not need this protocol; login/logout/listing/Cart/Order/Catalog/Report operations need no change. Factories/migrations are not live administrative operations. Direct SQL, future batch demotions, user deletion and a future self-demotion feature require a separate invariant design; row locking does not forbid a later direct writer from removing the final admin after this operation commits. The guarantee is for this Admin API, not a global database constraint.

The protocol is explicit in one Auth handler, reuses Laravel row locks already present in Cart/Order, and introduces no PostgreSQL-specific key or shared helper. Verify runtime READ COMMITTED before integration tests; different isolation can produce serialization errors and needs a deliberate retry strategy. No isolation/configuration changes are made automatically. Use bounded transaction retries for deadlock/serialization errors where supported, without treating exhausted retries as business 403/409.

Official reference: PostgreSQL 15 [row locks and deadlock ordering](https://www.postgresql.org/docs/15/explicit-locking.html#LOCKING-ROWS) and [READ COMMITTED](https://www.postgresql.org/docs/15/transaction-iso.html).

### Domain rules and existing conflict convention

User means the persisted authenticated identity; administrator means UserRole::ADMIN, not an owner or superuser. Only `admin` and `user` exist. Assuming at least one admin before an accepted operation, at least one admin must remain after commit. Zero-admin bootstrap and user deletion are outside scope.

Allowed: other-user promotion, other-admin demotion with an authorized distinct actor, and any same-role assignment. Forbidden: self-demotion (409), final-admin demotion (409), ordinary-user role assignment (403), invalid enum input (422). Last-admin conflict precedes self-demotion when both apply. No-op returns 200 with safe Resource and leaves role unchanged.

HTTP 409 is established, not invented: Shared TranslatableException defaults to 409; OrderService::updateStatus throws it for completed/cancelled Order transitions, and Feature/Order/UpdateOrderStatusTest asserts HTTP_CONFLICT and localized JSON messages. Auth will use the same state-conflict mechanism and existing bootstrap renderer. Authentication/authorization remains 401/403, syntactically invalid input remains 422.

GLOSSARY.md is not an OpenSpec dependency and provides no necessary extra workflow state for these few established terms. Remove the newly added root glossary; keep terminology and role rules here and in the spec. No standalone ADR is needed.

### Tests and architecture review

Two Feature files cover list and mutation, using RefreshDatabase, real JWT headers, UserFactory::admin(), Symfony status constants, exact response keys and database assertions. Cover missing/invalid JWT; ordinary-user 403 before input validation; default/max/custom pagination, invalid bounds and empty page; stable IDs; promotion/demotion/no-op; unknown numeric/non-numeric user; invalid/missing/wrong-type role; self/last-admin conflict precedence; English/Russian/fallback errors; unchanged credentials; old JWT reflecting new role on a fresh request.

Integration tests exercise the real handler with fresh and stale actor IDs and PostgreSQL concurrency. Multi-process tests use DatabaseMigrations so fixture records are committed and visible. Reuse the Cart worker/bootstrap pattern through a new Auth worker, passing the parent's effective test DB configuration privately rather than hardcoding credentials. Workers have timeouts and deterministic synchronization: parent connection locks the lower ID of A/B first; start two HTTP-kernel worker requests with real JWTs; wait until both have reached the handler and are blocked on that row (pg_stat_activity/pg_blocking_pids); then release. Do not depend on sleeps for correctness. Ensure separate fresh application requests and report only response status and safe data. Handler-only Integration tests independently cover stale actor input and rollback.

Cross-demotion fixture: exactly two admins A/B, concurrent PATCH A->B:user and B->A:user, both initially pass middleware. Either operation can win. If A wins, it locks A/B, confirms A admin, demotes B and commits (200). B resumes and sees its own fresh role=user, so fails authorization (403), never demoting A. Reverse winner is symmetric. Rule: administrative permission must still exist when the change executes, not only when middleware first ran. There must be one 200 and one 403, with exactly one admin left.

Same-target fixture: admins A/B both change a third user C. Locks overlap on C; operations execute in some serial order against fresh C. Both can return 200 if both actors stay admin. Identical requested roles make the second request a no-op; different roles leave C with the last successful serialized assignment. No optimistic version conflict is part of this interface, and waiting itself is not a reason for 403. Add explicit tests for identical assignments and conflicting assignments; assert only allowed serial outcomes. Test row locks release on rejected/rolled-back operations.

Use codebase-design locality/deletion test: one handler earns its interface by owning locking, authorization and invariants; read wrapper, user repository and enum DTO would only relocate trivial code. Thermo-nuclear review is separate after implementation: inspect the final diff for new layers, scattered conditions, unsafe serialization, stale authorization, transaction gaps and tests that hide races. No broad cleanup is authorized.

## Risks / Trade-offs

- [Future bypass or relaxed self-demotion] → Keep role writers on the documented handler protocol; redesign safety for batch writes/deletion/self-demotion before adding them. No database-wide constraint is claimed.
- [Stale JWT guard user] → Reload and authorize actor after waiting, preserving middleware behavior for all existing endpoints.
- [Participant lock contention/deadlocks] → Lock unique IDs in ascending order, keep transactions short, no external calls; unrelated participant pairs remain concurrent.
- [Isolation differs at runtime] → Verify READ COMMITTED; if different, resolve the transaction strategy before implementation instead of assuming count freshness.
- [Test-process fixture visibility and hangs] → DatabaseMigrations, deterministic wait detection, bounded process/lock waits and cleanup in finally.
- [Existing test suite needs PostgreSQL, MinIO and other services] → Run existing Docker checks after implementation; report exact infrastructure failures and never install dependencies automatically.
- [User table contains invalid legacy role] → Existing enum cast already assumes valid stored values; no unrelated data repair or schema tightening in Stage 10.

## Migration Plan

No schema/config/dependency migration. Deploy routes, Presentation classes, handler and translations together. Rollback removes the new interface and classes; accepted role changes are not automatically reverted. Preserve the existing Auth contracts. The user must approve this design before PHP edits.
