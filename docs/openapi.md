# OpenAPI deployment

The production Docker build runs `composer openapi` after installing runtime
dependencies and discovering packages. This generates and checks OpenAPI 3.0.3;
warnings from swagger-php are fatal. The check also requires the three documented
operations, unique operation IDs and resolvable local references.

`storage/api-docs/api-docs.json` is generated, not committed. Both it and local
environment files (at the repository root and in `app/`) are excluded from the
Docker context. The production stage
copies the generated file from the build stage. Production Compose resets the
application bind mount, so the image delivers the JSON without a separate CI
artifact download. Do not mount an empty directory over application storage:
it would hide the generated file.

The existing GitLab `tests` job runs `composer openapi` before the existing test
suite, which includes positive and negative OpenAPI infrastructure checks. There
is no second test pipeline. Production image builds enforce the same check with
`--no-dev` dependencies.

For local development (where Compose mounts `./app`) or to restore a removed file:

```sh
docker compose exec php composer openapi
```

The production entrypoint runs `config:cache` using runtime environment variables.
Generation does not need a database, application key, JWT secret or fixed origin.
Swagger UI is at `/api/doc`, JSON at `/docs` (the UI may append
`?api-docs.json`), and UI resources at `/docs/asset/...`. Nginx forwards these
requests to Laravel; it does not need access to `storage/api-docs` or `vendor`.
URLs are relative and the OpenAPI server is `/`, so the request origin determines
the domain, scheme and port.

Documentation is public, as configured by L5-Swagger. Per-request regeneration is
disabled. If the generated file is removed from a running container, JSON returns
404 until it is regenerated or the container is recreated from the image.
Validation uses the installed swagger-php validator plus project checks; it is
not a separate exhaustive OpenAPI JSON Schema validator. External `$ref` targets
are deliberately unsupported by `openapi:check`.
