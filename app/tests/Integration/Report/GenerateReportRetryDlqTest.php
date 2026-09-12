<?php

declare(strict_types=1);

namespace Tests\Integration\Report;

use App\Modules\Report\Application\Jobs\GenerateReportJob;
use App\Modules\Report\Infrastructure\Messaging\RabbitMqConnection;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Str;
use PhpAmqpLib\Wire\AMQPTable;
use Tests\TestCase;

final class GenerateReportRetryDlqTest extends TestCase
{
    use RefreshDatabase;

    private const string EXCHANGE = 'reports';

    private string $queue;

    private string $routingKey;

    private string $dlq;

    private string $dlqRoutingKey;

    public function test_failed_report_job_is_retried_and_routed_to_dlq(): void
    {
        $job = new GenerateReportJob(
            reportId: 999_999_999,
            messageId: (string) Str::uuid(),
        );

        $job->tries = 3;
        $job->backoff = 0;

        dispatch($job);

        $this->assertSame(
            1,
            $this->queueMessageCount($this->queue),
        );

        $this->runWorkerOnce();

        $this->assertSame(
            1,
            $this->queueMessageCount($this->queue),
        );

        $this->assertSame(
            0,
            $this->queueMessageCount($this->dlq),
        );

        $this->assertDatabaseCount(
            'failed_jobs',
            0,
        );

        $this->runWorkerOnce();

        $this->assertSame(
            1,
            $this->queueMessageCount($this->queue),
        );

        $this->assertSame(
            0,
            $this->queueMessageCount($this->dlq),
        );

        $this->assertDatabaseCount(
            'failed_jobs',
            0,
        );

        $this->runWorkerOnce();

        $this->assertSame(
            0,
            $this->queueMessageCount($this->queue),
        );

        $this->assertSame(
            1,
            $this->queueMessageCount($this->dlq),
        );

        $this->assertDatabaseCount(
            'failed_jobs',
            1,
        );
    }

    protected function setUp(): void
    {
        parent::setUp();

        $suffix = Str::lower(
            Str::replace(
                '-',
                '',
                (string) Str::uuid(),
            ),
        );

        $this->queue = 'reports.generate.integration.' . $suffix;
        $this->routingKey = $this->queue;
        $this->dlq = $this->queue . '.dlq';
        $this->dlqRoutingKey = $this->dlq;

        config([
            'queue.connections.rabbitmq.queue' => $this->queue,
            'queue.connections.rabbitmq.options.queue.exchange' => self::EXCHANGE,
            'queue.connections.rabbitmq.options.queue.exchange_type' => 'direct',
            'queue.connections.rabbitmq.options.queue.exchange_routing_key' => $this->routingKey,
            'queue.connections.rabbitmq.options.queue.reroute_failed' => true,
            'queue.connections.rabbitmq.options.queue.failed_exchange' => self::EXCHANGE,
            'queue.connections.rabbitmq.options.queue.failed_routing_key' => $this->dlqRoutingKey,
        ]);

        $this->declareTopology();
    }

    protected function tearDown(): void
    {
        $this->deleteQueue($this->queue);
        $this->deleteQueue($this->dlq);

        parent::tearDown();
    }

    private function declareTopology(): void
    {
        $connection = app(RabbitMqConnection::class)->connect();
        $channel = $connection->channel();

        try {
            $channel->exchange_declare(
                self::EXCHANGE,
                'direct',
                false,
                true,
                false,
            );

            $channel->queue_declare(
                $this->dlq,
                false,
                true,
                false,
                false,
            );

            $channel->queue_bind(
                $this->dlq,
                self::EXCHANGE,
                $this->dlqRoutingKey,
            );

            $arguments = new AMQPTable([
                'x-dead-letter-exchange' => self::EXCHANGE,
                'x-dead-letter-routing-key' => $this->dlqRoutingKey,
            ]);

            $channel->queue_declare(
                $this->queue,
                false,
                true,
                false,
                false,
                false,
                $arguments,
            );

            $channel->queue_bind(
                $this->queue,
                self::EXCHANGE,
                $this->routingKey,
            );
        } finally {
            if ($channel->is_open()) {
                $channel->close();
            }

            if ($connection->isConnected()) {
                $connection->close();
            }
        }
    }

    private function runWorkerOnce(): void
    {
        $exitCode = Artisan::call(
            'queue:work',
            [
                'connection' => 'rabbitmq',
                '--once' => true,
            ],
        );

        $this->assertSame(
            0,
            $exitCode,
            Artisan::output(),
        );
    }

    private function queueMessageCount(string $queue): int
    {
        $connection = app(RabbitMqConnection::class)->connect();
        $channel = $connection->channel();

        try {
            [, $messageCount] = $channel->queue_declare(
                $queue,
                true,
            );

            return $messageCount;
        } finally {
            if ($channel->is_open()) {
                $channel->close();
            }

            if ($connection->isConnected()) {
                $connection->close();
            }
        }
    }

    private function deleteQueue(string $queue): void
    {
        try {
            $connection = app(RabbitMqConnection::class)->connect();
            $channel = $connection->channel();

            try {
                $channel->queue_delete($queue);
            } finally {
                if ($channel->is_open()) {
                    $channel->close();
                }

                if ($connection->isConnected()) {
                    $connection->close();
                }
            }
        } catch (\Throwable) {
            // Queue may already be absent.
        }
    }
}
