<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use App\Modules\Report\Application\DTO\ReportGenerationMessage;
use App\Modules\Report\Application\Exceptions\InvalidReportMessageException;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use PhpAmqpLib\Channel\AMQPChannel;
use PhpAmqpLib\Message\AMQPMessage;

final readonly class ReportMessageFailureHandler
{
    public function __construct(
        private RabbitMqPublisher $publisher,
    ) {
    }

    public function handleInvalid(
        AMQPChannel $channel,
        AMQPMessage $message,
        InvalidReportMessageException $exception,
    ): void {
        try {
            $messageId = $this->resolveMessageId($message);

            $this->publisher->publishDlq(
                body: [
                    'message_id' => $messageId,
                    'message_type' => 'reports.generate.invalid',
                    'attempt' => 1,
                    'created_at' => now()->toISOString(),
                    'payload' => [],
                    'raw_body' => $message->getBody(),
                    'error' => [
                        'type' => $exception::class,
                        'message' => $exception->getMessage(),
                    ],
                ],
                messageId: $messageId,
            );

            $channel->basic_ack(
                $message->getDeliveryTag(),
            );

            report($exception);
        } catch (\Throwable $dlqException) {
            report($dlqException);

            $channel->basic_nack(
                $message->getDeliveryTag(),
                false,
                true,
            );
        }
    }

    public function handleProcessing(
        AMQPChannel $channel,
        AMQPMessage $message,
        ReportGenerationMessage $reportMessage,
        \Throwable $exception,
    ): void {
        try {
            $maxRetries = max(
                0,
                (int) config(
                    'rabbitmq.max_retries',
                    3,
                ),
            );

            $maxAttempts = $maxRetries + 1;

            if ($reportMessage->attempt < $maxAttempts) {
                Report::query()
                    ->whereKey($reportMessage->reportId)
                    ->where(
                        'status',
                        ReportStatus::PROCESSING->value,
                    )
                    ->update([
                        'status' => ReportStatus::PENDING->value,
                        'error' => $exception->getMessage(),
                    ]);

                $this->publisher->publishRetry(
                    $reportMessage,
                );

                $channel->basic_ack(
                    $message->getDeliveryTag(),
                );

                report($exception);

                return;
            }

            Report::query()
                ->whereKey($reportMessage->reportId)
                ->whereIn(
                    'status',
                    [
                        ReportStatus::PROCESSING->value,
                        ReportStatus::PENDING->value,
                    ],
                )
                ->update([
                    'status' => ReportStatus::FAILED->value,
                    'error' => $exception->getMessage(),
                ]);

            $this->publisher->publishDlq(
                body: [
                    ...$reportMessage->toArray(),
                    'error' => [
                        'type' => $exception::class,
                        'message' => $exception->getMessage(),
                    ],
                ],
                messageId: $reportMessage->messageId,
            );

            $channel->basic_ack(
                $message->getDeliveryTag(),
            );

            report($exception);
        } catch (\Throwable $publishException) {
            report($publishException);

            /*
             * The retry/DLQ message was not safely published.
             * Keep the original message available in RabbitMQ.
             */
            $channel->basic_nack(
                $message->getDeliveryTag(),
                false,
                true,
            );
        }
    }

    private function resolveMessageId(
        AMQPMessage $message,
    ): string {
        $messageId = $message->get('message_id');

        if (is_string($messageId) && $messageId !== '') {
            return $messageId;
        }

        return 'unknown-' . $message->getDeliveryTag();
    }
}
