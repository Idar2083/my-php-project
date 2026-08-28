<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\Contracts\ReportGenerationPublisher;
use App\Modules\Report\Application\DTO\ReportCompletedMessage;
use App\Modules\Report\Application\DTO\ReportGenerationMessage;
use PhpAmqpLib\Message\AMQPMessage;

final class RabbitMqPublisher implements
    ReportGenerationPublisher,
    ReportCompletionPublisher
{
    public function __construct(
        private readonly RabbitMqConnection $connection,
        private readonly RabbitMqTopology $topology,
    ) {
    }

    public function publishGeneration(
        ReportGenerationMessage $message,
    ): void {
        $this->publish(
            body: $message->toArray(),
            routingKey: (string) config(
                'rabbitmq.reports.generate.routing_key',
            ),
            messageId: $message->messageId,
            messageType: 'reports.generate',
        );
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
        );
    }

    public function publishRetry(
        ReportGenerationMessage $message,
    ): void {
        $this->publish(
            body: $message->nextAttempt()->toArray(),
            routingKey: (string) config(
                'rabbitmq.reports.retry.routing_key',
            ),
            messageId: $message->messageId,
            messageType: 'reports.generate.retry',
        );
    }

    /**
     * @param array<string, mixed> $body
     */
    public function publishDlq(
        array $body,
        string $messageId,
    ): void {
        $this->publish(
            body: $body,
            routingKey: (string) config(
                'rabbitmq.reports.dlq.routing_key',
            ),
            messageId: $messageId,
            messageType: 'reports.generate.dlq',
        );
    }

    /**
     * @param array<string, mixed> $body
     */
    private function publish(
        array $body,
        string $routingKey,
        string $messageId,
        string $messageType,
    ): void {
        $connection = $this->connection->connect();

        try {
            $channel = $connection->channel();

            $this->topology->declare($channel);

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
            throw new \RuntimeException(sprintf(
                'Unable to publish RabbitMQ message with routing key "%s".',
                $routingKey,
            ), $exception->getCode(), previous: $exception);
        } finally {
            if ($connection->isConnected()) {
                $connection->close();
            }
        }
    }
}
