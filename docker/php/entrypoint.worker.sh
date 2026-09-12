#!/bin/sh

set -e

php artisan reports:rabbitmq:setup

exec php artisan queue:work rabbitmq
