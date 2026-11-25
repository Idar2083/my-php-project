#!/bin/sh
# Read-only preflight. All cooperating publishers hold the CI resource_group.
set -eu
set +x

fail() {
    echo 'Release tag check failed: existing tag or unavailable Registry; use a new pipeline for a published release.' >&2
    exit 1
}

[ -n "${CI_REGISTRY_IMAGE-}" ] && [ -n "${CI_PIPELINE_ID-}" ] || fail
case "$CI_PIPELINE_ID" in *[!0-9]*|'') fail ;; esac
diagnostic=$(mktemp)
trap 'rm -f "$diagnostic"' EXIT
for service in php nginx; do
    reference="$CI_REGISTRY_IMAGE/$service:$CI_PIPELINE_ID"
    if docker manifest inspect "$reference" > /dev/null 2> "$diagnostic"; then
        fail
    fi
    # Docker's explicit missing-manifest response only. Authentication, network,
    # TLS, unknown CLI responses and mixed diagnostics must fail closed.
    [ "$(cat "$diagnostic")" = "no such manifest: $reference" ] || fail
done
