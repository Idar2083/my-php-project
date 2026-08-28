<?php

declare(strict_types=1);

namespace Tests\Feature\Report;

use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

final class GetReportTest extends TestCase
{
    use RefreshDatabase;

    public function test_can_get_report(): void
    {
        $report = $this->createReport(
            status: ReportStatus::COMPLETED,
            filePath: 'reports/1.jsonl',
        );

        $response = $this->getJson(
            '/api/reports/' . $report->id,
        );

        $response->assertStatus(
            Response::HTTP_OK,
        )->assertJson([
            'id' => $report->id,
            'status' => 'completed',
            'date_from' => '2026-08-01T00:00:00.000000Z',
            'date_to' => '2026-08-24T23:59:59.000000Z',
            'file_path' => 'reports/1.jsonl',
        ]);
    }

    public function test_can_get_pending_report(): void
    {
        $report = $this->createReport(
            status: ReportStatus::PENDING,
        );

        $response = $this->getJson(
            '/api/reports/' . $report->id,
        );

        $response->assertStatus(
            Response::HTTP_OK,
        )->assertJson([
            'id' => $report->id,
            'status' => 'pending',
            'file_path' => null,
        ]);
    }

    public function test_can_get_failed_report(): void
    {
        $report = $this->createReport(
            status: ReportStatus::FAILED,
            error: 'RabbitMQ is unavailable.',
        );

        $response = $this->getJson(
            '/api/reports/' . $report->id,
        );

        $response->assertStatus(
            Response::HTTP_OK,
        )->assertJson([
            'id' => $report->id,
            'status' => 'failed',
            'file_path' => null,
        ]);
    }

    public function test_returns_404_for_missing_report(): void
    {
        $response = $this->getJson(
            '/api/reports/999999',
        );

        $response->assertStatus(
            Response::HTTP_NOT_FOUND,
        );
    }

    private function createReport(
        ReportStatus $status,
        ?string $filePath = null,
        ?string $error = null,
    ): Report {
        return Report::query()->create([
            'status' => $status,
            'date_from' => '2026-08-01 00:00:00',
            'date_to' => '2026-08-24 23:59:59',
            'file_path' => $filePath,
            'error' => $error,
        ]);
    }
}
