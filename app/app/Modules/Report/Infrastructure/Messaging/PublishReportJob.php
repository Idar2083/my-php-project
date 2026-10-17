<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use App\Modules\Report\Application\Exceptions\RetryableReportPublicationException;
use App\Modules\Report\Application\Jobs\GenerateReportJob;
use App\Modules\Report\Domain\Events\ReportRequestedEvent;
use Illuminate\Support\Facades\DB;
use VladimirYuldashev\LaravelQueueRabbitMQ\Queue\QueueFactory;

final readonly class PublishReportJob
{
    public function __construct(private RabbitMqConnection $connection)
    {
    }

    public function handle(ReportRequestedEvent $event): void
    {
        // Never acknowledge an outbox publication from an uncommitted caller.
        if (DB::transactionLevel() !== 0) {
            throw new \RuntimeException('Report publication requires a committed outbox event.');
        }
        $connection = null;
        try {
            $connection = $this->connection->connect();
            $queue = QueueFactory::make(config('queue.connections.rabbitmq'));
            $queue->setContainer(app());
            $queue->setConnection($connection);
            $channel = $queue->getChannel();
            $channel->confirm_select();
            $reject = static function (): never {
                throw new \RuntimeException('Report job was not accepted by RabbitMQ.');
            };
            $channel->set_nack_handler($reject);
            $channel->set_return_listener($reject);
            $queue->push(new GenerateReportJob($event->reportId, $event->eventId), '', config('queue.connections.rabbitmq.queue'));
            $channel->wait_for_pending_acks_returns(5);
        } catch (\Throwable $exception) {
            throw new RetryableReportPublicationException('Report publication must be retried.', $exception->getCode(), previous: $exception);
        } finally {
            if ($connection?->isConnected()) {
                try {
                    $connection->close();
                } catch (\Throwable $exception) {
                    throw new RetryableReportPublicationException('Report publication cleanup must be retried.', $exception->getCode(), previous: $exception);
                }
            }
        }
    }
}
