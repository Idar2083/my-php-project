<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use PhpAmqpLib\Connection\AMQPStreamConnection;

final class RabbitMqConnection
{
    public function connect(): AMQPStreamConnection
    {
        $config = config('rabbitmq.connection');

        try {
            return new AMQPStreamConnection(
                host: $config['host'],
                port: $config['port'],
                user: $config['user'],
                password: $config['password'],
                vhost: $config['vhost'],
                connection_timeout: $config['connect_timeout'],
                read_write_timeout: $config['read_write_timeout'],
                heartbeat: $config['heartbeat'],
            );
        } catch (\Throwable $exception) {
            throw new \RuntimeException('Unable to connect to RabbitMQ.', $exception->getCode(), previous: $exception);
        }
    }
}
