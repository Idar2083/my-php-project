#!/bin/sh
set -eu

fail() {
    echo 'Release command failed: check arguments, state directory and operation lock.' >&2
    exit 1
}

case "${1-}" in
    status) [ "$#" -eq 2 ] || fail ;;
    check) [ "$#" -eq 5 ] || fail ;;
    accept-backup|mark-migrating) [ "$#" -eq 5 ] || fail ;;
    *) fail ;;
esac

# The directory must already exist. Opening it read-only creates/truncates nothing.
# Never remove or replace the directory while any release operation is running.
exec 9<"$2" || fail
flock -n -x 9 || fail
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
case "$1" in
    accept-backup|mark-migrating) exec node "$script_directory/backup.mjs" "$@" ;;
esac
exec node "$script_directory/state.mjs" "$@"
