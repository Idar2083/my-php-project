<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use App\Modules\Report\Application\Exceptions\InvalidReportMessageException;
use App\Modules\Report\Application\Handlers\GenerateReportHandler;
use PhpAmqpLib\Channel\AMQPChannel;
use PhpAmqpLib\Message\AMQPMessage;

final readonly class RabbitMqConsumer
{
    public function __construct(
        private RabbitMqConnection $connection,
        private RabbitMqTopology $topology,
        private ReportMessageDecoder $decoder,
        private GenerateReportHandler $handler,
        private ReportMessageFailureHandler $failureHandler,
    ) {
    }

    public function consume(): void
    {
        $connection = $this->connection->connect();

        try {
            $channel = $connection->channel();

            $this->topology->declare($channel);

            $channel->basic_qos(
                0,
                (int) config('rabbitmq.prefetch', 1),
                false,
            );

            $channel->basic_consume(
                (string) config(
                    'rabbitmq.reports.generate.queue',
                ),
                '',
                false,
                false,
                false,
                false,
                function (AMQPMessage $message) use ($channel): void {
                    $this->handleMessage($channel, $message);
                },
            );

            while ($channel->is_consuming()) {
                $channel->wait();
            }
        } finally {
            if ($connection->isConnected()) {
                $connection->close();
            }
        }
    }

    private function handleMessage(
        AMQPChannel $channel,
        AMQPMessage $message,
    ): void {
        try {
            $reportMessage = $this->decoder->decode(
                $message->getBody(),
            );
        } catch (InvalidReportMessageException $exception) {
            $this->failureHandler->handleInvalid(
                channel: $channel,
                message: $message,
                exception: $exception,
            );

            return;
        }

        try {
            $this->handler->handle($reportMessage);

            $channel->basic_ack(
                $message->getDeliveryTag(),
            );
        } catch (\Throwable $exception) {
            $this->failureHandler->handleProcessing(
                channel: $channel,
                message: $message,
                reportMessage: $reportMessage,
                exception: $exception,
            );
        }
    }
}
