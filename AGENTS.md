# AGENTS.md

## Project

Pizza Backend — Laravel API for an online pizza and drinks store.

The project is a modular Laravel application. Preserve the existing architecture and conventions when implementing new functionality.

The application source code is located in:

```text
app/
```

## Stack

- PHP 8.4 in Docker; Composer requires PHP ^8.3.0
- Laravel 13
- PostgreSQL
- Redis
- RabbitMQ
- MinIO / S3-compatible storage
- Docker Compose
- PHPUnit
- PHPStan / Larastan
- PHP-CS-Fixer
- Rector
- JWT authentication

## Architecture

The application uses a modular architecture.

Main application modules are located in:

```text
app/app/Modules/
```

Shared application code is located in:

```text
app/app/Shared/
```

Modules may contain the following layers:

```text
Application/
Domain/
Infrastructure/
Presentation/
```

The existing layers contain:

- `Application/` — services, handlers, contracts, DTOs, jobs, and listeners, depending on the module.
- `Domain/` — Eloquent models, enums, events, and the Order address DTO.
- `Infrastructure/` — persistence adapters, mail, storage, RabbitMQ messaging, and console commands in modules that have this layer.
- `Presentation/` — controllers, form requests, API resources, middleware, and the Catalog product observer.

This is not a strictly isolated Clean Architecture. Domain models depend on Eloquent, and existing Application services and handlers use Eloquent and Laravel transactions directly. Preserve these conventions rather than introducing a new persistence layer for a local change.

The exact structure may differ between modules. Do not assume that every module contains all of these layers.

Always inspect the existing structure before adding, moving, or refactoring code.

When modifying a module, follow the conventions already established in that module.

Reuse existing abstractions when they are suitable. Do not redesign the architecture for a local task.

## Project Locations

- `app/app/Modules/` — application modules.
- `app/app/Shared/` — shared outbox contracts, processing, persistence, and translatable exceptions.
- `app/app/Http/` — common Controller, ApiRequest, and locale middleware.
- `app/app/Providers/AppServiceProvider.php` — dependency bindings, event listeners, and observers.
- `app/routes/api.php` — API routes, including authenticated and admin route groups.
- `app/routes/web.php` — root status endpoint.
- `app/routes/console.php` — scheduled daily report command.
- `app/tests/Feature/`, `app/tests/Integration/`, `app/tests/Unit/` — tests.
- `app/tests/Support/` — concurrency test support.
- `app/phpunit.xml` — test configuration.

## Current Modules

The main existing modules are:

- Auth
- Cart
- Catalog
- Order
- Report

Before modifying a module, inspect its existing implementation.

Do not assume that the listed modules have identical internal structures.

## Shared Code

Shared application code is located in:

```text
app/app/Shared/
```

Before creating a new shared class, contract, DTO, exception, service, or utility, check whether suitable functionality already exists.

Keep module-specific domain and business logic in its owning module; do not move it into `Shared/`. Shared code must serve an established cross-module need.

## Development Rules

- Keep changes focused on the requested task.
- Do not modify unrelated code.
- Follow the existing architecture and coding conventions.
- Follow the existing naming, namespace, directory, and dependency conventions.
- Prefer existing services, DTOs, contracts, exceptions, repositories, events, jobs, and other abstractions when applicable.
- Do not duplicate existing functionality.
- Do not introduce new dependencies unless they are required by the task.
- Do not introduce new architectural patterns, layers, or abstractions without a task-specific justification.
- Use the existing patterns of the module being changed, not assumptions about other modules.
- Do not change Auth or JWT behavior unless required by the task.
- Keep controllers thin.
- Keep business logic out of controllers when an appropriate Application or Domain layer exists.
- Keep infrastructure-specific implementation details inside the Infrastructure layer.
- Keep transport-specific logic inside the Presentation layer.
- Validate external input at the appropriate application boundary.
- Preserve existing API contracts unless the task explicitly requires a change.
- Preserve backward compatibility unless the task explicitly requires a breaking change.
- Do not expose passwords, password hashes, secrets, or other sensitive information through API responses or logs. Authentication tokens belong only in the existing authentication responses; do not expose them in other responses or logs.
- Follow the existing error-handling and exception conventions.
- Follow the existing conventions for queues, jobs, events, messaging, caching, and storage.
- Add or update tests when changing functionality.
- Do not remove or weaken existing tests to make a change pass.

## Laravel Rules

- Use Laravel mechanisms already established in the project.
- Use Form Requests or the project's existing validation mechanism for HTTP input validation.
- Use API Resources or the project's existing response mechanism for API responses.
- Use dependency injection where appropriate.
- Use Laravel configuration for environment-specific settings.
- Do not hardcode credentials, secrets, URLs, ports, or other environment-specific values.
- Follow the project's existing conventions for queues, jobs, events, listeners, commands, caching, and storage.

## Database Rules

- Use Laravel migrations for database schema changes.
- Do not modify the database schema manually when the change should be represented by a migration.
- Follow existing naming conventions for tables, columns, indexes, foreign keys, and constraints.
- Do not make destructive schema changes unless explicitly required.
- Consider existing data and backward compatibility when modifying database structures.

## Testing and Quality

Run the relevant tests and quality checks after making changes.

Configured test suites (Feature and Integration):

```bash
docker compose exec php ./vendor/bin/phpunit
```

`app/phpunit.xml` uses PostgreSQL and does not include `tests/Unit` in its configured suites. Run relevant Unit tests explicitly when needed:

```bash
docker compose exec php ./vendor/bin/phpunit tests/Unit
```

PHPStan:

```bash
docker compose exec php ./vendor/bin/phpstan analyse
```

PHP-CS-Fixer:

```bash
docker compose exec php ./vendor/bin/php-cs-fixer fix --dry-run --diff
```

Rector:

```bash
docker compose exec php ./vendor/bin/rector process --dry-run
```

Composer validation:

```bash
docker compose exec php composer validate --strict
```

Docker Compose configuration validation:

```bash
docker compose --env-file .env --env-file .env.local -f docker-compose.yml -f docker-compose.prod.yml config --quiet
```

The root `Makefile` also provides `make test` (Docker, `php artisan test`), and host commands `make phpstan`, `make cs-dr`, and `make rector-dr` executed from `app/`. `make cs` and `make rector` apply changes.

The quality pipeline is defined in `.gitlab-ci.yml`: PHPStan, PHP-CS-Fixer dry-run, Rector dry-run, and tests via `php artisan test`. CI invokes PHPStan with `app routes config database`; the default `app/phpstan.neon.dist` paths are `app`, `config`, and `routes`.

Quality configuration files are `app/phpstan.neon.dist`, `app/.php-cs-fixer.dist.php` (loaded by `app/.php-cs-fixer.php`), and `app/rector.php`.

When a task affects only a specific module or functionality, run the relevant tests first.

Run the full test suite when appropriate.

Run additional project-specific quality checks when they are configured and relevant to the changed code.

Do not consider a task complete if relevant tests or static analysis fail because of the changes.

## Code Style

Follow the existing project code style and PHP-CS-Fixer configuration.

Use strict typing and type declarations consistently with the existing codebase.

Prefer explicit and readable code over unnecessary abstractions.

Do not make unrelated formatting changes.

## Working with Existing Code

Before implementing a change:

1. Inspect the relevant module and its existing structure.
2. Identify existing services, contracts, DTOs, repositories, events, jobs, requests, resources, and tests related to the task.
3. Reuse existing implementations where appropriate.
4. Determine where the new functionality belongs according to the existing architecture.
5. Implement the smallest change that satisfies the requirements.
6. Add or update tests for the changed behavior.
7. Run the relevant quality checks.

When an existing implementation conflicts with a general architectural assumption, prefer the actual project conventions unless the task explicitly requires changing them.

## Git and Changes

- Do not reset, revert, or overwrite unrelated user changes.
- Do not modify files unrelated to the requested task.
- Do not commit changes unless explicitly requested.
- Keep changes focused and reviewable.
- Preserve unrelated uncommitted changes.

## AI Agent Rules

- Analyze the existing architecture, relevant module code, and tests before making changes.
- Do not introduce new patterns or architectural layers without a concrete justification.
- Do not perform bulk refactoring outside the requested task.
- Preserve public API contracts unless the task requires changing them.
- Validate code changes with relevant tests and quality pipeline checks; report any checks that could not be run.
- Read the relevant code before making assumptions.
- Do not invent classes, methods, directories, configuration options, or dependencies when existing project code can be inspected.
- When requirements are ambiguous, use the existing project implementation and conventions as the primary source of truth.
- Prefer a small, consistent change over a broad refactoring.
- Do not refactor unrelated code while implementing a feature or fixing a bug.
- Explain important implementation decisions briefly when they affect architecture or behavior.
- After implementation, report which tests and quality checks were run and their results.