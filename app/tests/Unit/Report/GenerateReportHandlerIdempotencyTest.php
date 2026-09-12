<?php

declare(strict_types=1);

namespace Tests\Unit\Report;

use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\Contracts\ReportOrderItemReader;
use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Application\DTO\ReportCompletedMessage;
use App\Modules\Report\Application\Handlers\GenerateReportHandler;
use App\Modules\Report\Application\Services\JsonlReportWriter;
use App\Modules\Report\Application\Services\ReportGenerationService;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\LazyCollection;
use Tests\TestCase;

final class GenerateReportHandlerIdempotencyTest extends TestCase
{
    use RefreshDatabase;

    public function test_duplicate_delivery_of_completed_report_only_publishes_completion(): void
    {
        $report = Report::query()->create([
            'status' => ReportStatus::COMPLETED,
            'date_from' => CarbonImmutable::today()->startOfDay(),
            'date_to' => CarbonImmutable::tomorrow()->startOfDay(),
            'file_path' => 'reports/1.jsonl',
        ]);

        $reader = new class () implements ReportOrderItemReader {
            public function between(
                \DateTimeInterface $dateFrom,
                \DateTimeInterface $dateTo,
            ): LazyCollection {
                throw new \RuntimeException(
                    'Report generation must not run for an already completed report.',
                );
            }
        };

        $storage = new class () implements ReportStorage {
            public function put(
                string $path,
                $stream,
            ): void {
                throw new \RuntimeException(
                    'Storage must not be called for an already completed report.',
                );
            }

            public function exists(string $path): bool
            {
                return true;
            }

            public function readStream(string $path)
            {
                return false;
            }

            public function delete(string $path): void
            {
            }
        };

        $generationService = new ReportGenerationService(
            orderItemReader: $reader,
            writer: new JsonlReportWriter(),
            storage: $storage,
        );

        $publisher = new class () implements ReportCompletionPublisher {
            /** @var list<ReportCompletedMessage> */
            public array $messages = [];

            public function publishCompleted(
                ReportCompletedMessage $message,
            ): void {
                $this->messages[] = $message;
            }
        };

        $handler = new GenerateReportHandler(
            generationService: $generationService,
            publisher: $publisher,
        );

        $messageId = 'duplicate-message-id';

        $handler->handle(
            reportId: $report->id,
            messageId: $messageId,
        );

        $handler->handle(
            reportId: $report->id,
            messageId: $messageId,
        );

        $report->refresh();

        $this->assertSame(
            ReportStatus::COMPLETED,
            $report->status,
        );

        $this->assertSame(
            'reports/1.jsonl',
            $report->file_path,
        );

        $this->assertCount(
            2,
            $publisher->messages,
        );

        $this->assertSame(
            $messageId . ':completed',
            $publisher->messages[0]->messageId,
        );

        $this->assertSame(
            $messageId . ':completed',
            $publisher->messages[1]->messageId,
        );
    }
}
