#!/bin/sh
set -eu

cd "$CI_PROJECT_DIR"
# State files contain only generated resource identifiers, never credentials.
if [ -f reports/production-check.container ]; then
    container=$(cat reports/production-check.container)
    printf '%s\n' "$container" | grep -Eq '^[a-f0-9]{64}$'
    owner=$(docker inspect --format '{{index .Config.Labels "pizza.ci.production-job"}}' "$container" 2>/dev/null || true)
    if [ "$owner" = "$CI_JOB_ID" ]; then
        docker rm -f "$container" >/dev/null
    fi
fi
if [ -f reports/production-check.project ]; then
    project=$(cat reports/production-check.project)
    printf '%s\n' "$project" | grep -Eq '^pizza-stage122-[a-f0-9]{12}$'
    # Fallback for an interrupted Node process: operate only on this random project.
    containers=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=pizza.ci.production-check=$project" --filter "label=pizza.ci.production-job=$CI_JOB_ID")
    if [ -n "$containers" ]; then docker rm -f $containers >/dev/null; fi
    networks=$(docker network ls -q --filter "label=com.docker.compose.project=$project" --filter "label=pizza.ci.production-check=$project" --filter "label=pizza.ci.production-job=$CI_JOB_ID")
    if [ -n "$networks" ]; then docker network rm $networks >/dev/null; fi
    volumes=$(docker volume ls -q --filter "label=com.docker.compose.project=$project" --filter "label=pizza.ci.production-check=$project" --filter "label=pizza.ci.production-job=$CI_JOB_ID")
    if [ -n "$volumes" ]; then docker volume rm $volumes >/dev/null; fi
fi

rm -f reports/production-check.source.tar
