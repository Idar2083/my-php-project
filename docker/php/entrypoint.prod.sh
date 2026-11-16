#!/bin/sh

set -e

php artisan config:cache

exec "$@"