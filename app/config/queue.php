<?php

declare(strict_types=1);

return [

    /*
    |--------------------------------------------------------------------------
    | Default Queue Connection Name
    |--------------------------------------------------------------------------
    */

    'default' => env('QUEUE_CONNECTION', 'database'),

    /*
    |--------------------------------------------------------------------------
    | Queue Connections
    |--------------------------------------------------------------------------
    */

    'connections' => [

        'sync' => [
            'driver' => 'sync',
        ],

        'database' => [
            'driver' => 'database',
            'connection' => env('DB_QUEUE_CONNECTION'),
            'table' => env('DB_QUEUE_TABLE', 'jobs'),
            'queue' => env('DB_QUEUE', 'default'),
            'retry_after' => (int) env('DB_QUEUE_RETRY_AFTER', 90),
            'after_commit' => false,
        ],

        'beanstalkd' => [
            'driver' => 'beanstalkd',
            'host' => env('BEANSTALKD_QUEUE_HOST', 'localhost'),
            'queue' => env('BEANSTALKD_QUEUE', 'default'),
            'retry_after' => (int) env('BEANSTALKD_QUEUE_RETRY_AFTER', 90),
            'block_for' => 0,
            'after_commit' => false,
        ],

        'sqs' => [
            'driver' => 'sqs',
            'key' => env('AWS_ACCESS_KEY_ID'),
            'secret' => env('AWS_SECRET_ACCESS_KEY'),
            'prefix' => env(
                'SQS_PREFIX',
                'https://sqs.us-east-1.amazonaws.com/your-account-id',
            ),
            'queue' => env('SQS_QUEUE', 'default'),
            'suffix' => env('SQS_SUFFIX'),
            'region' => env('AWS_DEFAULT_REGION', 'us-east-1'),
            'after_commit' => false,
        ],

        'redis' => [
            'driver' => 'redis',
            'connection' => env('REDIS_QUEUE_CONNECTION', 'default'),
            'queue' => env('REDIS_QUEUE', 'default'),
            'retry_after' => (int) env('REDIS_QUEUE_RETRY_AFTER', 90),
            'block_for' => null,
            'after_commit' => false,
        ],

        'rabbitmq' => [
            'driver' => 'rabbitmq',

            'queue' => env(
                'RABBITMQ_QUEUE',
                'reports.generate',
            ),

            'hosts' => [
                [
                    'host' => env(
                        'RABBITMQ_HOST',
                        'rabbitmq',
                    ),
                    'port' => (int) env(
                        'RABBITMQ_PORT',
                        5_672,
                    ),
                    'user' => env('RABBITMQ_USER'),
                    'password' => env('RABBITMQ_PASSWORD'),
                    'vhost' => env(
                        'RABBITMQ_VHOST',
                        '/',
                    ),
                ],
            ],

            'options' => [
                'queue' => [
                    'exchange' => env(
                        'RABBITMQ_REPORTS_EXCHANGE',
                        'reports',
                    ),
                    'exchange_type' => 'direct',
                    'exchange_routing_key' => env(
                        'RABBITMQ_REPORTS_GENERATE_ROUTING_KEY',
                        'reports.generate',
                    ),

                    'reroute_failed' => true,

                    'failed_exchange' => env(
                        'RABBITMQ_REPORTS_EXCHANGE',
                        'reports',
                    ),

                    'failed_routing_key' => env(
                        'RABBITMQ_REPORTS_DLQ_ROUTING_KEY',
                        'reports.generate.dlq',
                    ),
                ],
            ],
        ],

        'deferred' => [
            'driver' => 'deferred',
        ],

        'background' => [
            'driver' => 'background',
        ],

        'failover' => [
            'driver' => 'failover',
            'connections' => [
                'database',
                'deferred',
            ],
        ],
    ],

    /*
    |--------------------------------------------------------------------------
    | Job Batching
    |--------------------------------------------------------------------------
    */

    'batching' => [
        'database' => env('DB_CONNECTION', 'sqlite'),
        'table' => 'job_batches',
    ],

    /*
    |--------------------------------------------------------------------------
    | Failed Queue Jobs
    |--------------------------------------------------------------------------
    */

    'failed' => [
        'driver' => env(
            'QUEUE_FAILED_DRIVER',
            'database-uuids',
        ),
        'database' => env(
            'DB_CONNECTION',
            'sqlite',
        ),
        'table' => 'failed_jobs',
    ],
];
