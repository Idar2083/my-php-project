<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use PhpAmqpLib\Channel\AMQPChannel;

final readonly class RabbitMqTopology
{
    public function declareGenerate(AMQPChannel $channel): void
    {
        $exchange = config('rabbitmq.reports.exchange');

        $this->declareExchange(
            channel: $channel,
            name: $exchange['name'],
            type: $exchange['type'],
            durable: $exchange['durable'],
        );

        $this->declareQueue(
            channel: $channel,
            exchange: $exchange['name'],
            queue: (string) config(
                'rabbitmq.reports.generate.queue',
            ),
            routingKey: (string) config(
                'rabbitmq.reports.generate.routing_key',
            ),
        );
    }

    public function declareCompleted(AMQPChannel $channel): void
    {
        $exchange = config('rabbitmq.reports.exchange');

        $this->declareExchange(
            channel: $channel,
            name: $exchange['name'],
            type: $exchange['type'],
            durable: $exchange['durable'],
        );

        $this->declareQueue(
            channel: $channel,
            exchange: $exchange['name'],
            queue: (string) config(
                'rabbitmq.reports.completed.queue',
            ),
            routingKey: (string) config(
                'rabbitmq.reports.completed.routing_key',
            ),
        );
    }

    private function declareExchange(
        AMQPChannel $channel,
        string $name,
        string $type,
        bool $durable,
    ): void {
        $channel->exchange_declare(
            $name,
            $type,
            false,
            $durable,
            false,
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
}
