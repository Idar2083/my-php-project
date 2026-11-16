#!/bin/sh
set -eu
# Installed and reviewed on the VPS; never execute a script straight from stdin.
[ "$#" -eq 6 ] || exit 1
case "$1" in /*) ;; *) exit 1 ;; esac
exec 9<"$1/shared/state"
flock -n -x 9 || { echo 'Production release lock is busy.' >&2; exit 1; }
exec node "$(dirname -- "$0")/deploy-server.mjs" "$@"
