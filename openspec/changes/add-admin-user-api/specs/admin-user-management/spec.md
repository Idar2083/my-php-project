# Spec Delta

## Purpose

Allow administrators to inspect users and manage roles without exposing credentials or accidentally removing all administrative access.

## ADDED Requirements

### Requirement: Administrator access
The system SHALL require a valid JWT and a current administrator role for GET `/api/admin/users` and PATCH `/api/admin/users/{userId}/role`.

#### Scenario: Missing authentication
- **WHEN** either endpoint receives a request without a JWT
- **THEN** it returns 401 and no user data or role mutation

#### Scenario: Ordinary user
- **WHEN** either endpoint receives a valid JWT for an ordinary user
- **THEN** it returns 403, including requests with invalid input or an unknown target

### Requirement: Bounded stable pagination
The list SHALL return 200 with `data`, `links`, and `meta`, sorted by ascending unique user ID. `page` SHALL be a positive integer. `per_page` SHALL be an integer from 1 to 100, defaulting to 20. Invalid pagination SHALL return 422; an empty or out-of-range page SHALL return an empty data array.

#### Scenario: Default list
- **WHEN** an administrator requests the list without pagination parameters
- **THEN** up to 20 users are returned in ascending ID order with total and page metadata

#### Scenario: Explicit pages
- **WHEN** an administrator requests adjacent pages with `per_page=2` against unchanged data
- **THEN** pages contain ordered, non-overlapping users and correct pagination metadata

#### Scenario: Invalid pagination
- **WHEN** page is zero, negative, non-integer, or per_page is outside 1 through 100 or non-integer
- **THEN** the response is 422 with validation errors for the offending parameter

#### Scenario: Empty page
- **WHEN** the requested page has no users
- **THEN** the response is 200 with empty data and pagination metadata

### Requirement: Safe user representation
Every user object returned by either endpoint SHALL contain exactly `id`, `name`, `email`, `role`, and `created_at`. It SHALL never contain password hashes, remember tokens, JWTs, authentication tokens, or additional model attributes.

#### Scenario: Explicit allowlist
- **WHEN** users with passwords and remember tokens are listed or returned after a role update
- **THEN** each user object contains only the five allowed fields and role is `admin` or `user`

### Requirement: Validated role assignment
The role endpoint SHALL accept a required string role of `admin` or `user`, update only that role, and return 200 with the safe user object under `data`. An unknown numeric user ID SHALL return 404 when input is valid. Invalid or missing role SHALL return 422. A non-numeric user ID SHALL return 404 through route matching.

#### Scenario: Promotion
- **WHEN** an administrator assigns `admin` to another ordinary user
- **THEN** the target becomes an administrator and the response is 200

#### Scenario: Demotion with another administrator remaining
- **WHEN** an administrator assigns `user` to a different administrator
- **THEN** the target becomes an ordinary user and the response is 200

#### Scenario: Unknown target
- **WHEN** an administrator submits a valid role for an unknown numeric user ID
- **THEN** the response is 404 and existing users remain unchanged

#### Scenario: Invalid role
- **WHEN** an administrator submits an absent, null, array, numeric, unknown, or differently cased role
- **THEN** the response is 422 and roles remain unchanged

#### Scenario: Same role assignment
- **WHEN** an administrator assigns a target's existing role, including their own `admin` role
- **THEN** the response is 200 and no effective role change occurs

### Requirement: Self-demotion protection
An administrator SHALL NOT change their own role from admin to user. The system SHALL return 409 and preserve the role, including when other administrators exist.

#### Scenario: Multiple administrators and self-demotion
- **WHEN** an administrator attempts self-demotion while another administrator exists
- **THEN** the response is 409 with the localized self-demotion message and no mutation

### Requirement: Last administrator protection
An operation that would remove the last administrator SHALL return 409 and preserve the administrator. This conflict SHALL take precedence over self-demotion when both conditions apply. This operation SHALL not create an initial administrator when none exists.

#### Scenario: Last administrator demotion
- **WHEN** the only administrator attempts to assign themselves `user`
- **THEN** the response is 409 with the localized last-administrator message and an administrator remains

### Requirement: Concurrent role safety
Role mutations sharing participants SHALL execute in a safe serial order and be authorized against current persisted state before committing. Concurrent requests SHALL NOT remove all administrators. A caller demoted while waiting SHALL receive 403 instead of executing a previously authorized mutation.

#### Scenario: Two administrators demote each other
- **WHEN** two administrators concurrently attempt to demote one another
- **THEN** one succeeds, the other is rejected with 403 after reauthorization, and one administrator remains

#### Scenario: Waiting caller loses its role
- **WHEN** a role-change caller is demoted before their waiting operation resumes
- **THEN** their operation returns 403 and does not mutate its target

#### Scenario: Two administrators assign the same target role
- **WHEN** two administrators concurrently assign the same role to a third user and both retain admin access
- **THEN** both requests return 200, the target has that role, and the second assignment is an idempotent no-op

#### Scenario: Two administrators assign different roles to one target
- **WHEN** two administrators concurrently assign different valid roles to a third user and both retain admin access
- **THEN** both requests return 200 and the final target role equals the last successful serialized assignment

### Requirement: Compatibility and error safety
Existing register, login, me, logout and other module contracts SHALL remain unchanged. New conflicts SHALL use localized messages following the existing language negotiation and SHALL NOT expose exception classes, traces, file paths, or SQL.

#### Scenario: Localized conflict
- **WHEN** a role conflict is requested with English, Russian, or an unsupported locale
- **THEN** the existing locale negotiation returns the appropriate English/Russian message or English fallback, with no internal details

#### Scenario: Existing JWT after role change
- **WHEN** a user's role is changed and they use their existing valid JWT on a subsequent admin request
- **THEN** access reflects their current stored role without requiring a new JWT
