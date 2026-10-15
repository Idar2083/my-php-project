#!/bin/sh

set -e

php -r 'if (!extension_loaded("pcntl") || !function_exists("pcntl_async_signals")) { fwrite(STDERR, "Queue worker requires pcntl.\n"); exit(1); }'

php artisan reports:rabbitmq:setup

exec php artisan queue:work rabbitmq
