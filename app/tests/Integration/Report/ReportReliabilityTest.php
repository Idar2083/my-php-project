<?php

declare(strict_types=1);

namespace Tests\Integration\Report;

use App\Modules\Report\Application\Exceptions\RetryableReportPublicationException;
use App\Modules\Report\Application\Handlers\CreateReportHandler;
use App\Modules\Report\Application\Jobs\GenerateReportJob;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Events\ReportRequestedEvent;
use App\Modules\Report\Domain\Models\Report;
use App\Modules\Report\Infrastructure\Messaging\PublishReportJob;
use App\Modules\Report\Infrastructure\Messaging\RabbitMqConnection;
use App\Shared\Application\Outbox\Contracts\OutboxEventRepository;
use App\Shared\Application\Outbox\OutboxProcessor;
use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use PhpAmqpLib\Wire\AMQPTable;
use Symfony\Component\Process\Process;
use Tests\TestCase;

final class ReportReliabilityTest extends TestCase
{
    use DatabaseMigrations;

    private string $queue;

    public function test_report_and_outbox_commit_before_any_broker_publication(): void
    {
        DB::beginTransaction();
        try {
            $report = $this->createReport();
            $this->assertSame(0, $this->queueCount());
            config(['database.connections.observer' => config('database.connections.pgsql')]);
            $this->assertSame(0, DB::connection('observer')->table('reports')->count());
            $this->assertSame(0, DB::connection('observer')->table('outbox_events')->count());
            DB::commit();
        } finally {
            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            DB::disconnect('observer');
        }
        $this->assertSame(0, $this->queueCount());
        $this->assertSame(1, app(OutboxProcessor::class)->process());
        $this->assertSame(1, $this->queueCount());
        $this->assertSame(ReportStatus::PENDING, $report->fresh()->status);
        $this->assertNotNull(DB::table('outbox_events')->value('published_at'));
    }

    public function test_rollback_removes_both_report_and_delivery_intent(): void
    {
        DB::beginTransaction();
        $this->createReport();
        DB::rollBack();
        $this->assertDatabaseCount('reports', 0);
        $this->assertDatabaseCount('outbox_events', 0);
        $this->assertSame(0, app(OutboxProcessor::class)->process());
        $this->assertSame(0, $this->queueCount());
    }

    public function test_outbox_keeps_retrying_publication_after_repeated_broker_failures(): void
    {
        $this->createReport();
        $eventId = DB::table('outbox_events')->value('event_id');
        Event::forget(ReportRequestedEvent::class);
        Event::listen(ReportRequestedEvent::class, static function (): never {
            throw new RetryableReportPublicationException('Controlled broker failure.');
        });
        for ($attempt = 0; $attempt < 6; $attempt++) {
            $this->assertSame(1, app(OutboxProcessor::class)->process());
        }
        $this->assertDatabaseHas('outbox_events', ['event_id' => $eventId, 'attempts' => 6, 'published_at' => null, 'failed_at' => null]);
        Event::forget(ReportRequestedEvent::class);
        Event::listen(ReportRequestedEvent::class, PublishReportJob::class);
        app(OutboxProcessor::class)->process();
        $this->assertSame(1, $this->queueCount());
        $this->assertNotNull(DB::table('outbox_events')->value('published_at'));
    }

    public function test_actual_broker_connection_failure_leaves_a_retryable_outbox_event(): void
    {
        $this->createReport();
        $port = config('rabbitmq.connection.port');
        config(['rabbitmq.connection.port' => 1, 'rabbitmq.connection.connect_timeout' => 1]);
        try {
            app(OutboxProcessor::class)->process();
            $this->assertDatabaseHas('outbox_events', ['attempts' => 1, 'published_at' => null, 'failed_at' => null]);
        } finally {
            config(['rabbitmq.connection.port' => $port]);
        }
        app(OutboxProcessor::class)->process();
        $this->assertSame(1, $this->queueCount());
    }

    public function test_publication_is_repeated_after_a_crash_before_marking_the_outbox_published(): void
    {
        $report = $this->createReport();
        $claimed = app(OutboxEventRepository::class)->claimPending(1)[0];
        app(PublishReportJob::class)->handle(new ReportRequestedEvent($claimed->event_id, $report->id, now()->toImmutable()));
        // Simulate the lost acknowledgement window: broker accepted the job,
        // publisher died before markPublished, and its persisted lease expired.
        DB::table('outbox_events')->where('id', $claimed->id)->update(['processing_at' => now()->subMinutes(6)]);
        app(OutboxProcessor::class)->process();
        $this->assertSame(2, $this->queueCount());
        $this->assertNotNull(DB::table('outbox_events')->value('published_at'));
        $this->runWorker();
        $this->runWorker('crash');
        $this->assertSame(ReportStatus::COMPLETED, $report->fresh()->status);
        $this->assertSame(0, $this->queueCount());
    }

    public function test_exhausted_temporary_storage_failures_are_dead_lettered_and_not_left_pending(): void
    {
        $report = Report::factory()->create();
        $this->enqueue($report);
        $this->runWorker('storage-down');
        $this->runWorker('storage-down');
        $this->assertSame(ReportStatus::PENDING, $report->fresh()->status);
        $this->runWorker('storage-down');
        $this->assertSame(ReportStatus::FAILED, $report->fresh()->status);
        $this->assertSame(0, $this->queueCount());
        $this->assertSame(1, $this->queueCount($this->queue . '.dlq'));
        $this->assertDatabaseCount('failed_jobs', 1);
    }

    public function test_real_s3_connection_failure_is_retried_then_completes(): void
    {
        $report = Report::factory()->create();
        $this->enqueue($report);
        $this->runWorker('storage-down');
        $this->assertSame(ReportStatus::PENDING, $report->fresh()->status);
        $this->assertSame(1, $this->queueCount());
        $this->runWorker();
        $this->assertSame(ReportStatus::COMPLETED, $report->fresh()->status);
        $this->assertTrue(Storage::disk('s3')->exists($report->fresh()->file_path));
        $this->assertSame(0, $this->queueCount());
        $this->assertSame(0, $this->queueCount($this->queue . '.dlq'));
    }

    public function test_killed_worker_is_redelivered_after_real_s3_upload_without_losing_the_report(): void
    {
        $report = Report::factory()->create();
        $this->enqueue($report);
        $worker = $this->worker('crash');
        $worker->start();
        try {
            $deadline = microtime(true) + 15;
            while (!str_contains($worker->getOutput(), 'uploaded') && $worker->isRunning() && microtime(true) < $deadline) {
                usleep(20_000);
            }
            $this->assertStringContainsString('uploaded', $worker->getOutput(), 'The real S3 upload must finish before SIGKILL.');
            $this->assertSame(ReportStatus::PENDING, $report->fresh()->status, 'Uncommitted processing must not escape the transaction.');
            $worker->signal(9);
            $worker->wait();
        } finally {
            if ($worker->isRunning()) {
                $worker->stop(0, 9);
            }
        }
        $this->waitForMessage();
        $this->assertTrue(Storage::disk('s3')->exists('reports/' . $report->id . '.jsonl'));
        $this->runWorker();
        $this->assertSame(ReportStatus::COMPLETED, $report->fresh()->status);
        // A duplicate must publish completion without invoking put again: the
        // crash fixture would block forever if generation were repeated.
        $this->enqueue($report);
        $this->runWorker('crash');
        $this->assertSame(ReportStatus::COMPLETED, $report->fresh()->status);
        $this->assertSame(0, $this->queueCount());
    }

    public function test_legacy_processing_without_a_live_owner_can_be_reclaimed(): void
    {
        $report = Report::factory()->create(['status' => ReportStatus::PROCESSING]);
        $this->enqueue($report);
        $this->runWorker();
        $this->assertSame(ReportStatus::COMPLETED, $report->fresh()->status);
    }

    public function test_permanent_encoding_failure_is_failed_and_dead_lettered(): void
    {
        $report = Report::factory()->create();
        $this->enqueue($report);
        $this->runWorker('invalid-data');
        $this->assertSame(ReportStatus::FAILED, $report->fresh()->status);
        $this->assertSame(0, $this->queueCount());
        $this->assertSame(1, $this->queueCount($this->queue . '.dlq'));
        $this->assertDatabaseCount('failed_jobs', 1);
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->assertSame('pgsql', DB::connection()->getDriverName());
        $this->queue = 'reports.stage1.' . Str::uuid();
        config([
            'queue.connections.rabbitmq.queue' => $this->queue,
            'queue.connections.rabbitmq.options.queue.exchange_routing_key' => $this->queue,
            'queue.connections.rabbitmq.options.queue.failed_routing_key' => $this->queue . '.dlq',
        ]);
        $connection = app(RabbitMqConnection::class)->connect();
        try {
            $channel = $connection->channel();
            $channel->exchange_declare('reports', 'direct', false, true, false);
            $channel->queue_declare($this->queue . '.dlq', false, true, false, false);
            $channel->queue_bind($this->queue . '.dlq', 'reports', $this->queue . '.dlq');
            $channel->queue_declare($this->queue, false, true, false, false, false, new AMQPTable([
                'x-dead-letter-exchange' => 'reports', 'x-dead-letter-routing-key' => $this->queue . '.dlq',
            ]));
            $channel->queue_bind($this->queue, 'reports', $this->queue);
        } finally {
            $connection->close();
        }
    }

    protected function tearDown(): void
    {
        try {
            foreach (Report::query()->pluck('id') as $id) {
                Storage::disk('s3')->delete('reports/' . $id . '.jsonl');
            }
            $connection = app(RabbitMqConnection::class)->connect();
            try {
                $channel = $connection->channel();
                $channel->queue_delete($this->queue);
                $channel->queue_delete($this->queue . '.dlq');
            } finally {
                $connection->close();
            }
        } finally {
            parent::tearDown();
        }
    }

    private function createReport(): Report
    {
        return app(CreateReportHandler::class)->handle(now()->startOfDay(), now()->startOfDay());
    }

    private function enqueue(Report $report): void
    {
        $job = new GenerateReportJob($report->id, 'reliability-' . $report->id);
        $job->backoff = 0;
        Queue::connection('rabbitmq')->push($job, '', $this->queue);
    }

    private function worker(string $mode): Process
    {
        $worker = new Process([PHP_BINARY, base_path('tests/Support/report_queue_worker.php')], timeout: 25);
        $worker->setInput(json_encode([
            'database' => config('database.connections.pgsql'), 'queue' => config('queue.connections.rabbitmq'),
            'rabbitmq' => config('rabbitmq'), 's3' => config('filesystems.disks.s3'), 'mode' => $mode,
        ], JSON_THROW_ON_ERROR));

        return $worker;
    }

    private function runWorker(string $mode = 'normal'): void
    {
        $worker = $this->worker($mode);
        $worker->run();
        $this->assertTrue($worker->isSuccessful(), 'Isolated report queue worker failed.');
    }

    private function queueCount(?string $name = null): int
    {
        $connection = app(RabbitMqConnection::class)->connect();
        try {
            [, $count] = $connection->channel()->queue_declare($name ?? $this->queue, true);

            return $count;
        } finally {
            $connection->close();
        }
    }

    private function waitForMessage(): void
    {
        $deadline = microtime(true) + 10;
        do {
            if ($this->queueCount() === 1) {
                return;
            }
            usleep(20_000);
        } while (microtime(true) < $deadline);
        $this->fail('The killed worker message was not redelivered.');
    }
}
