#!/bin/sh
set -eu

cd "${CI_PROJECT_DIR:?}"
fail() {
    echo 'Production integration requires a clean committed checkout matching CI_COMMIT_SHA, including all MinIO/CI files; commit the complete reviewed set before running the pipeline.' >&2
    exit 1
}

[ -n "${CI_COMMIT_SHA-}" ] || fail
[ "$(git rev-parse HEAD)" = "$CI_COMMIT_SHA" ] || fail
git ls-files --error-unmatch -- \
    .gitlab-ci.yml docker-compose.yml docker-compose.prod.yml \
    docker/ci/archive-production-source.sh docker/ci/check-minio-images.sh \
    docker/ci/production-integration.sh docker/ci/Dockerfile.production-check \
    docker/minio/Dockerfile.server docker/minio/Dockerfile.mc \
    docker/minio/images.test.mjs docker/minio/ci.test.mjs \
    frontend/tests-production/run.js >/dev/null 2>&1 || fail
git diff --quiet HEAD -- . || fail
[ -z "$(git ls-files --others --exclude-standard)" ] || fail

mkdir -p reports
git archive --format=tar --output=reports/production-check.source.tar HEAD
