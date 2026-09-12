<?php

declare(strict_types=1);

namespace Tests\Unit\Report;

use App\Modules\Report\Application\Contracts\ReportOrderItemReader;
use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Application\Services\JsonlReportWriter;
use App\Modules\Report\Application\Services\ReportGenerationService;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Carbon\CarbonImmutable;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\LazyCollection;
use PHPUnit\Framework\MockObject\MockObject;
use Tests\TestCase;

final class ReportGenerationServiceFailureTest extends TestCase
{
    use RefreshDatabase;

    public function test_storage_failure_marks_report_as_failed(): void
    {
        $report = Report::query()->create([
            'status' => ReportStatus::PROCESSING,
            'date_from' => CarbonImmutable::today()->startOfDay(),
            'date_to' => CarbonImmutable::tomorrow()->startOfDay(),
        ]);

        $reader = new class () implements ReportOrderItemReader {
            public function between(
                \DateTimeInterface $dateFrom,
                \DateTimeInterface $dateTo,
            ): LazyCollection {
                return LazyCollection::make([]);
            }
        };

        /** @var ReportStorage&MockObject $storage */
        $storage = $this->createMock(ReportStorage::class);

        $storage
            ->expects($this->once())
            ->method('put')
            ->willThrowException(
                new \RuntimeException('MinIO is unavailable.'),
            );

        $service = new ReportGenerationService(
            orderItemReader: $reader,
            writer: new JsonlReportWriter(),
            storage: $storage,
        );

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('MinIO is unavailable.');

        try {
            $service->generate($report);
        } finally {
            $report->refresh();

            $this->assertSame(
                ReportStatus::FAILED,
                $report->status,
            );

            $this->assertSame(
                'MinIO is unavailable.',
                $report->error,
            );

            $this->assertNull($report->file_path);
        }
    }
}
