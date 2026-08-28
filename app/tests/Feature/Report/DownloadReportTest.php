<?php

declare(strict_types=1);

namespace Tests\Feature\Report;

use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

final class DownloadReportTest extends TestCase
{
    use RefreshDatabase;

    public function test_can_download_report(): void
    {
        $report = $this->createReport(
            filePath: 'reports/1.jsonl',
        );

        $storage = $this->mock(ReportStorage::class);

        $storage
            ->shouldReceive('exists')
            ->once()
            ->with('reports/1.jsonl')
            ->andReturnTrue();

        $stream = fopen('php://temp', 'w+b');

        fwrite(
            $stream,
            "{\"product_name\":\"Margherita\",\"price\":500,\"amount\":2,\"user\":{\"id\":34}}\n",
        );

        rewind($stream);

        $storage
            ->shouldReceive('readStream')
            ->once()
            ->with('reports/1.jsonl')
            ->andReturn($stream);

        $response = $this->get(
            '/api/reports/' . $report->id . '/download',
        );

        $response->assertStatus(Response::HTTP_OK);
        $response->assertHeader(
            'Content-Type',
            'application/x-ndjson',
        );
        $response->assertHeader(
            'Content-Disposition',
            'attachment; filename=report-' . $report->id . '.jsonl',
        );
    }

    public function test_returns_404_when_report_file_path_is_missing(): void
    {
        $report = $this->createReport(
            filePath: null,
        );

        $storage = $this->mock(ReportStorage::class);

        $storage
            ->shouldNotReceive('exists');

        $storage
            ->shouldNotReceive('readStream');

        $response = $this->get(
            '/api/reports/' . $report->id . '/download',
        );

        $response->assertStatus(
            Response::HTTP_NOT_FOUND,
        );
    }

    public function test_returns_404_when_report_file_does_not_exist(): void
    {
        $report = $this->createReport(
            filePath: 'reports/missing.jsonl',
        );

        $storage = $this->mock(ReportStorage::class);

        $storage
            ->shouldReceive('exists')
            ->once()
            ->with('reports/missing.jsonl')
            ->andReturnFalse();

        $storage
            ->shouldNotReceive('readStream');

        $response = $this->get(
            '/api/reports/' . $report->id . '/download',
        );

        $response->assertStatus(
            Response::HTTP_NOT_FOUND,
        );
    }

    public function test_returns_404_for_missing_report(): void
    {
        $storage = $this->mock(ReportStorage::class);

        $storage
            ->shouldNotReceive('exists');

        $storage
            ->shouldNotReceive('readStream');

        $response = $this->get(
            '/api/reports/999999/download',
        );

        $response->assertStatus(
            Response::HTTP_NOT_FOUND,
        );
    }

    private function createReport(
        ?string $filePath,
    ): Report {
        return Report::query()->create([
            'status' => $filePath === null
                ? ReportStatus::PENDING
                : ReportStatus::COMPLETED,
            'date_from' => '2026-08-01 00:00:00',
            'date_to' => '2026-08-24 23:59:59',
            'file_path' => $filePath,
            'error' => null,
        ]);
    }
}
