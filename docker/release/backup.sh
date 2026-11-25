#!/bin/sh
set -eu
fail() { echo 'Backup command failed: check arguments, paths and operation lock.' >&2; exit 1; }
case "${1-}" in
    preflight|verify|restore-test) [ "$#" -eq 4 ] || fail ;;
    create) [ "$#" -eq 5 ] || fail ;;
    *) fail ;;
esac
exec 9<"$2" || fail
flock -n -x 9 || fail
script_directory=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
exec node "$script_directory/backup.mjs" "$@"
