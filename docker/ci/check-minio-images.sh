#!/bin/sh
set -eu

fail() {
    echo 'Set MINIO_CI_IMAGE and MINIO_MC_CI_IMAGE to published project minio-community/mc-community sha256 references; see the release runbook.' >&2
    exit 1
}

case "${1-}" in ''|--validate-only|--pull-only) ;; *) fail ;; esac
[ "$#" -le 1 ] || fail
[ -n "${CI_REGISTRY_IMAGE-}" ] || fail
validate() {
    case "$1" in "$CI_REGISTRY_IMAGE/$2@sha256:"*) ;; *) fail ;; esac
    digest=${1##*@sha256:}
    [ "$1" = "$CI_REGISTRY_IMAGE/$2@sha256:$digest" ] || fail
    [ "${#digest}" -eq 64 ] || fail
    case "$digest" in *[!0-9a-f]*) fail ;; esac
}
validate "${MINIO_CI_IMAGE-}" minio-community
validate "${MINIO_MC_CI_IMAGE-}" mc-community
[ "${1-}" != --validate-only ] || exit 0

docker pull "$MINIO_CI_IMAGE"
docker pull "$MINIO_MC_CI_IMAGE"
[ "${1-}" != --pull-only ] || exit 0

# Reuse the existing Node + Docker CLI tooling recipe; never publish this image.
[ -n "${CI_JOB_ID-}" ] || fail
tools_image="$CI_REGISTRY_IMAGE/minio-check-tools:$CI_JOB_ID"
docker build -f docker/ci/Dockerfile.production-check -t "$tools_image" .
# Only the public contract test enters the helper through stdin. Registry
# credentials stay in the job's temporary DOCKER_CONFIG, outside the helper.
docker run --rm -i --pull=never --network=none --read-only \
    --tmpfs /tmp:rw,nosuid,nodev \
    --label "pizza.ci.minio-job=$CI_JOB_ID" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e DOCKER_HOST=unix:///var/run/docker.sock \
    -e MINIO_IMAGE_DOCKER_TEST=1 \
    -e "MINIO_TEST_SERVER_IMAGE=$MINIO_CI_IMAGE" \
    -e "MINIO_TEST_CLIENT_IMAGE=$MINIO_MC_CI_IMAGE" \
    "$tools_image" node --input-type=module < docker/minio/images.test.mjs
