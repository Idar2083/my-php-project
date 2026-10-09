# Proposal

## Why

Administrators cannot currently list users or manage their roles through the API. Stage 10 adds these operations while preventing sensitive-field exposure and accidental loss of all administrative access.

## What Changes

- Add GET `/api/admin/users` with validated pagination (default 20, maximum 100), ascending user ID order and explicit safe response fields.
- Add PATCH `/api/admin/users/{userId}/role` accepting the existing UserRole values through a Form Request.
- Reuse JWT authentication and AdminMiddleware; anonymous callers receive 401 and ordinary users receive 403.
- Reject self-demotion with 409; assigning the existing role is an idempotent 200 operation.
- Protect the last administrator and lock actor and target rows in PostgreSQL, rechecking the actor's current authorization after waiting for the lock.
- Add HTTP contract and real concurrent-transaction tests and run the existing quality pipeline after implementation.

## Capabilities

### New Capabilities

- `admin-user-management`: Administrative user listing and safe, authorized role changes, including self-role and last-administrator invariants.

### Modified Capabilities

None. No existing OpenSpec capabilities are present.

## Impact

Auth Presentation and Application additions, API routes, English/Russian messages, Auth Feature/Integration tests and a test worker. No schema migration, dependency, repository abstraction, Policy/Gate, separate Admin module or JWT configuration change. Existing `/register`, `/login`, `/me`, `/logout`, Catalog, Cart, Order and Report contracts remain intact. PostgreSQL is already the application's configured database.

No standalone glossary is required; domain terms and decisions live in the change design. This change contains planning artifacts only until the user approves implementation. The proposed self-demotion and last-admin responses are presented for approval with this plan.
