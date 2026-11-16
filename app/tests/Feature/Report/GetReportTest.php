<?php

declare(strict_types=1);

namespace Tests\Feature\Report;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class GetReportTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    public function test_can_get_report(): void
    {
        $report = Report::factory()
            ->state([
                'status' => ReportStatus::COMPLETED,
                'file_path' => 'reports/1.jsonl',
            ])
            ->create();

        $response = $this->getJson(
            '/api/reports/' . $report->id,
        );

        $response
            ->assertStatus(Response::HTTP_OK)
            ->assertJson([
                'id' => $report->id,
                'status' => 'completed',
                'date_from' => '2026-08-01T00:00:00.000000Z',
                'date_to' => '2026-08-24T23:59:59.000000Z',
                'file_path' => 'reports/1.jsonl',
            ]);
    }

    public function test_can_get_pending_report(): void
    {
        $report = Report::factory()->create();

        $response = $this->getJson(
            '/api/reports/' . $report->id,
        );

        $response
            ->assertStatus(Response::HTTP_OK)
            ->assertJson([
                'id' => $report->id,
                'status' => 'pending',
                'file_path' => null,
            ]);
    }

    public function test_can_get_failed_report(): void
    {
        $report = Report::factory()
            ->state([
                'status' => ReportStatus::FAILED,
                'error' => 'RabbitMQ is unavailable.',
            ])
            ->create();

        $response = $this->getJson(
            '/api/reports/' . $report->id,
        );

        $response
            ->assertStatus(Response::HTTP_OK)
            ->assertJson([
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

    protected function setUp(): void
    {
        parent::setUp();

        $this->admin = User::factory()
            ->admin()
            ->create();

        $this->withHeader(
            'Authorization',
            'Bearer ' . JWTAuth::fromUser($this->admin),
        );
    }
}
