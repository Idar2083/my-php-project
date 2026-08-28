<?php

declare(strict_types=1);

return [
    'connection' => [
        'host' => env('RABBITMQ_HOST', 'rabbitmq'),
        'port' => (int) env('RABBITMQ_PORT', 5_672),
        'user' => env('RABBITMQ_USER'),
        'password' => env('RABBITMQ_PASSWORD'),
        'vhost' => env('RABBITMQ_VHOST', '/'),

        'connect_timeout' => (float) env(
            'RABBITMQ_CONNECT_TIMEOUT',
            5,
        ),

        'read_write_timeout' => (float) env(
            'RABBITMQ_READ_WRITE_TIMEOUT',
            10,
        ),

        'heartbeat' => (int) env(
            'RABBITMQ_HEARTBEAT',
            30,
        ),
    ],

    'reports' => [
        'exchange' => [
            'name' => env('RABBITMQ_REPORTS_EXCHANGE', 'reports'),
            'type' => 'direct',
            'durable' => true,
        ],

        'generate' => [
            'queue' => env(
                'RABBITMQ_REPORTS_GENERATE_QUEUE',
                'reports.generate',
            ),

            'routing_key' => env(
                'RABBITMQ_REPORTS_GENERATE_ROUTING_KEY',
                'reports.generate',
            ),
        ],

        'retry' => [
            'queue' => env(
                'RABBITMQ_REPORTS_RETRY_QUEUE',
                'reports.generate.retry',
            ),
            'routing_key' => env(
                'RABBITMQ_REPORTS_RETRY_ROUTING_KEY',
                'reports.generate.retry',
            ),
            'delay' => (int) env(
                'RABBITMQ_REPORTS_RETRY_DELAY',
                5_000,
            ),
        ],

        'dlq' => [
            'queue' => env(
                'RABBITMQ_REPORTS_DLQ_QUEUE',
                'reports.generate.dlq',
            ),

            'routing_key' => env(
                'RABBITMQ_REPORTS_DLQ_ROUTING_KEY',
                'reports.generate.dlq',
            ),
        ],

        'completed' => [
            'queue' => env(
                'RABBITMQ_REPORTS_COMPLETED_QUEUE',
                'reports.completed',
            ),

            'routing_key' => env(
                'RABBITMQ_REPORTS_COMPLETED_ROUTING_KEY',
                'reports.completed',
            ),
        ],
    ],

    'prefetch' => (int) env('RABBITMQ_PREFETCH', 1),

    'max_retries' => (int) env('RABBITMQ_REPORTS_MAX_RETRIES', 3),
];
