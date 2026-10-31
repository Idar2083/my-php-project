#!/bin/sh
set -eu

cd "$CI_PROJECT_DIR"
mkdir -p reports
# Archive only the clean reviewed commit, before any Docker/network operations.
sh docker/ci/archive-production-source.sh
# Pull the already verified private images on this job's daemon. The helper
# receives only digest references, never Registry credentials.
sh docker/ci/check-minio-images.sh --pull-only
trap 'sh "$CI_PROJECT_DIR/docker/ci/cleanup-production-check.sh"' EXIT

tools_image="pizza-ci-production-tools:$CI_JOB_ID"
docker build -f docker/ci/Dockerfile.production-check -t "$tools_image" .
project=$(docker run --rm --network none "$tools_image" node -e 'process.stdout.write("pizza-stage122-" + require("node:crypto").randomBytes(6).toString("hex"))')
printf '%s\n' "$project" > reports/production-check.project
container=$(docker create -i --network bridge \
    --label "pizza.ci.production-job=$CI_JOB_ID" \
    -v /var/run/docker.sock:/var/run/docker.sock \
    -e DOCKER_HOST=unix:///var/run/docker.sock \
    -e PRODUCTION_CHECK_NETWORK=container \
    -e "PRODUCTION_CHECK_PROJECT=$project" \
    -e PRODUCTION_EXPORT_IMAGES=1 \
    -e "MINIO_IMAGE=$MINIO_CI_IMAGE" -e "MINIO_MC_IMAGE=$MINIO_MC_CI_IMAGE" \
    -e CI_REGISTRY_IMAGE -e CI_PIPELINE_ID -e CI_JOB_ID -e CI_COMMIT_SHA \
    "$tools_image" sh -ec 'mkdir -p /workspace; tar -xf - -C /workspace; node /workspace/frontend/tests-production/run.js')
printf '%s\n' "$container" > reports/production-check.container
# Send the verified commit through stdin: no assumption about host paths on the daemon.
docker start -ai "$container" < reports/production-check.source.tar
docker cp "$container:/workspace/reports/production-images.tar.gz" reports/production-images.tar.gz
docker cp "$container:/workspace/reports/production-images.ids" reports/production-images.ids
sha256sum reports/production-images.tar.gz > reports/production-images.sha256
