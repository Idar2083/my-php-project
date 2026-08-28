<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use PhpAmqpLib\Channel\AMQPChannel;
use PhpAmqpLib\Wire\AMQPTable;

final class RabbitMqTopology
{
    public function declare(AMQPChannel $channel): void
    {
        $exchange = config('rabbitmq.reports.exchange');

        $channel->exchange_declare(
            $exchange['name'],
            $exchange['type'],
            false,
            $exchange['durable'],
            false,
        );

        $this->declareQueue(
            channel: $channel,
            exchange: $exchange['name'],
            queue: config('rabbitmq.reports.generate.queue'),
            routingKey: config('rabbitmq.reports.generate.routing_key'),
        );

        $this->declareRetryQueue(
            channel: $channel,
            exchange: $exchange['name'],
            queue: config('rabbitmq.reports.retry.queue'),
            routingKey: config('rabbitmq.reports.retry.routing_key'),
        );

        $this->declareQueue(
            channel: $channel,
            exchange: $exchange['name'],
            queue: config('rabbitmq.reports.dlq.queue'),
            routingKey: config('rabbitmq.reports.dlq.routing_key'),
        );

        $this->declareQueue(
            channel: $channel,
            exchange: $exchange['name'],
            queue: config('rabbitmq.reports.completed.queue'),
            routingKey: config('rabbitmq.reports.completed.routing_key'),
        );
    }

    private function declareQueue(
        AMQPChannel $channel,
        string $exchange,
        string $queue,
        string $routingKey,
    ): void {
        $channel->queue_declare(
            $queue,
            false,
            true,
            false,
            false,
        );

        $channel->queue_bind(
            $queue,
            $exchange,
            $routingKey,
        );
    }

    private function declareRetryQueue(
        AMQPChannel $channel,
        string $exchange,
        string $queue,
        string $routingKey,
    ): void {
        $arguments = new AMQPTable([
            'x-message-ttl' => (int) config(
                'rabbitmq.reports.retry.delay',
                5_000,
            ),
            'x-dead-letter-exchange' => $exchange,
            'x-dead-letter-routing-key' => config(
                'rabbitmq.reports.generate.routing_key',
            ),
        ]);

        $channel->queue_declare(
            $queue,
            false,
            true,
            false,
            false,
            false,
            $arguments,
        );

        $channel->queue_bind(
            $queue,
            $exchange,
            $routingKey,
        );
    }
}
