<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\DTO\ReportCompletedMessage;
use PhpAmqpLib\Message\AMQPMessage;

final class RabbitMqPublisher implements ReportCompletionPublisher
{
    public function __construct(
        private readonly RabbitMqConnection $connection,
        private readonly RabbitMqTopology $topology,
    ) {
    }

    public function publishCompleted(
        ReportCompletedMessage $message,
    ): void {
        $this->publish(
            body: $message->toArray(),
            routingKey: (string) config(
                'rabbitmq.reports.completed.routing_key',
            ),
            messageId: $message->messageId,
            messageType: 'reports.completed',
            declareTopology: fn (\PhpAmqpLib\Channel\AMQPChannel $channel) => $this->topology->declareCompleted(
                $channel,
            ),
        );
    }

    /**
     * @param array<string, mixed> $body
     * @param callable(\PhpAmqpLib\Channel\AMQPChannel): void $declareTopology
     */
    private function publish(
        array $body,
        string $routingKey,
        string $messageId,
        string $messageType,
        callable $declareTopology,
    ): void {
        $connection = $this->connection->connect();

        try {
            $channel = $connection->channel();

            $declareTopology($channel);

            $channel->confirm_select();

            $encodedBody = json_encode(
                $body,
                JSON_THROW_ON_ERROR
                | JSON_UNESCAPED_UNICODE
                | JSON_UNESCAPED_SLASHES,
            );

            $message = new AMQPMessage(
                $encodedBody,
                [
                    'content_type' => 'application/json',
                    'delivery_mode' => AMQPMessage::DELIVERY_MODE_PERSISTENT,
                    'message_id' => $messageId,
                    'type' => $messageType,
                ],
            );

            $channel->basic_publish(
                $message,
                (string) config('rabbitmq.reports.exchange.name'),
                $routingKey,
                true,
            );

            $channel->wait_for_pending_acks_returns();
        } catch (\Throwable $exception) {
            throw new \RuntimeException(
                sprintf(
                    'Unable to publish RabbitMQ message with routing key "%s".',
                    $routingKey,
                ),
                $exception->getCode(),
                previous: $exception,
            );
        } finally {
            if ($connection->isConnected()) {
                $connection->close();
            }
        }
    }
}
