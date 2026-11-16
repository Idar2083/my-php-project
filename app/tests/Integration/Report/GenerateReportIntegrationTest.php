<?php

declare(strict_types=1);

namespace Tests\Integration\Report;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Catalog\Domain\Models\Product;
use App\Modules\Order\Domain\Enums\OrderStatus;
use App\Modules\Order\Domain\Models\Order;
use App\Modules\Order\Domain\Models\OrderItem;
use App\Modules\Report\Application\Jobs\GenerateReportJob;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use App\Modules\Report\Infrastructure\Messaging\RabbitMqConnection;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use PhpAmqpLib\Wire\AMQPTable;
use Tests\TestCase;

final class GenerateReportIntegrationTest extends TestCase
{
    use RefreshDatabase;

    private const string EXCHANGE = 'reports';

    private string $queue;

    private string $routingKey;

    public function test_report_is_generated_through_rabbitmq_queue_worker_and_stored_in_minio(): void
    {
        $user = User::factory()->create();

        $product = Product::factory()->create([
            'name' => 'Integration Test Pizza',
            'price' => 500,
        ]);

        $order = Order::query()->create([
            'user_id' => $user->id,
            'status' => OrderStatus::PAID,
            'total_price' => 1_000,
            'delivery_method' => 'courier',
            'region' => 'Test region',
            'city' => 'Test city',
            'street' => 'Test street',
            'house' => '1',
            'entrance' => '1',
            'apartment' => '10',
            'postal_code' => '123456',
            'paid_at' => CarbonImmutable::now(),
        ]);

        OrderItem::query()->create([
            'order_id' => $order->id,
            'product_id' => $product->id,
            'product_name' => $product->name,
            'quantity' => 2,
            'price' => $product->price,
        ]);

        $report = Report::query()->create([
            'status' => ReportStatus::PENDING,
            'date_from' => CarbonImmutable::today()->startOfDay(),
            'date_to' => CarbonImmutable::tomorrow()->startOfDay(),
        ]);

        $messageId = (string) Str::uuid();

        GenerateReportJob::dispatch(
            reportId: $report->id,
            messageId: $messageId,
        );

        $this->assertSame(
            1,
            $this->queueMessageCount($this->queue),
        );

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

        $report->refresh();

        $this->assertSame(
            ReportStatus::COMPLETED,
            $report->status,
            sprintf(
                'Report generation failed: %s',
                $report->error ?? 'unknown error',
            ),
        );

        $this->assertNotNull($report->file_path);

        $this->assertTrue(
            Storage::disk('s3')->exists($report->file_path),
        );

        $stream = Storage::disk('s3')->readStream($report->file_path);

        $this->assertIsResource($stream);

        try {
            $content = stream_get_contents($stream);

            $this->assertIsString($content);

            $lines = array_values(
                array_filter(
                    explode("\n", trim($content)),
                    static fn (string $line): bool => $line !== '',
                ),
            );

            $this->assertCount(2, $lines);

            foreach ($lines as $line) {
                $data = json_decode(
                    $line,
                    true,
                    512,
                    JSON_THROW_ON_ERROR,
                );

                $this->assertSame(
                    $product->name,
                    $data['product_name'],
                );

                $this->assertSame(
                    500,
                    $data['price'],
                );

                $this->assertSame(
                    1,
                    $data['amount'],
                );

                $this->assertSame(
                    $user->id,
                    $data['user']['id'],
                );
            }
        } finally {
            fclose($stream);

            Storage::disk('s3')->delete($report->file_path);
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

        $this->queue = 'reports.generate.integration.' . $suffix;
        $this->routingKey = $this->queue;

        config([
            'queue.connections.rabbitmq.queue' => $this->queue,
            'queue.connections.rabbitmq.options.queue.exchange' => self::EXCHANGE,
            'queue.connections.rabbitmq.options.queue.exchange_type' => 'direct',
            'queue.connections.rabbitmq.options.queue.exchange_routing_key' => $this->routingKey,
            'queue.connections.rabbitmq.options.queue.reroute_failed' => true,
            'queue.connections.rabbitmq.options.queue.failed_exchange' => self::EXCHANGE,
            'queue.connections.rabbitmq.options.queue.failed_routing_key' => $this->queue . '.dlq',

            'filesystems.disks.s3.driver' => 's3',
            'filesystems.disks.s3.key' => (string) env('MINIO_ROOT_USER'),
            'filesystems.disks.s3.secret' => (string) env('MINIO_ROOT_PASSWORD'),
            'filesystems.disks.s3.region' => 'us-east-1',
            'filesystems.disks.s3.bucket' => 'reports',
            'filesystems.disks.s3.endpoint' => 'http://minio:9000',
            'filesystems.disks.s3.use_path_style_endpoint' => true,
        ]);

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

            $arguments = new AMQPTable([
                'x-dead-letter-exchange' => self::EXCHANGE,
                'x-dead-letter-routing-key' => $this->queue . '.dlq',
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
        }
    }
}
