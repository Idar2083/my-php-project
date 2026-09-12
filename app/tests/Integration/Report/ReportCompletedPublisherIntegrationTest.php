<?php

declare(strict_types=1);

namespace Tests\Integration\Report;

use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\DTO\ReportCompletedMessage;
use App\Modules\Report\Infrastructure\Messaging\RabbitMqConnection;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PhpAmqpLib\Wire\AMQPTable;
use Tests\TestCase;

final class ReportCompletedPublisherIntegrationTest extends TestCase
{
    use RefreshDatabase;

    private const string EXCHANGE = 'reports';

    private string $queue;

    private string $routingKey;

    public function test_completed_message_is_published_to_real_rabbitmq(): void
    {
        $message = new ReportCompletedMessage(
            messageId: (string) Str::uuid(),
            reportId: 123,
            filePath: 'reports/123.jsonl',
            createdAt: new \DateTimeImmutable(),
        );

        $publisher = app(ReportCompletionPublisher::class);

        config([
            'rabbitmq.reports.completed.routing_key' => $this->routingKey,
        ]);

        $publisher->publishCompleted($message);

        $connection = app(RabbitMqConnection::class)->connect();
        $channel = $connection->channel();

        try {
            $result = $channel->basic_get(
                $this->queue,
                true,
            );

            $this->assertNotNull(
                $result,
                'Expected reports.completed message in RabbitMQ.',
            );

            $body = json_decode(
                $result->getBody(),
                true,
                512,
                JSON_THROW_ON_ERROR,
            );

            $this->assertSame(
                $message->messageId,
                $body['message_id'],
            );

            $this->assertSame(
                'reports.completed',
                $body['message_type'],
            );

            $this->assertSame(
                $message->reportId,
                $body['payload']['report_id'],
            );

            $this->assertSame(
                $message->filePath,
                $body['payload']['file_path'],
            );

            $this->assertSame(
                'application/json',
                $result->get('content_type'),
            );

            $this->assertSame(
                'reports.completed',
                $result->get('type'),
            );

            $this->assertSame(
                $message->messageId,
                $result->get('message_id'),
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

        $this->queue = 'reports.completed.integration.' . $suffix;
        $this->routingKey = $this->queue;

        $this->declareTopology();
    }

    protected function tearDown(): void
    {
        $this->deleteQueue($this->queue);

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
                $this->queue,
                false,
                true,
                false,
                false,
                false,
                new AMQPTable(),
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
