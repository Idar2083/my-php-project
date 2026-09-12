<?php

declare(strict_types=1);

namespace Tests\Feature\Report;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class DownloadReportTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    public function test_can_download_report(): void
    {
        $report = Report::factory()
            ->state([
                'status' => ReportStatus::COMPLETED,
                'file_path' => 'reports/1.jsonl',
            ])
            ->create();

        $storage = $this->mock(ReportStorage::class);

        $storage
            ->shouldReceive('exists')
            ->once()
            ->with('reports/1.jsonl')
            ->andReturnTrue();

        $stream = fopen('php://temp', 'w+b');

        self::assertIsResource($stream);

        fwrite(
            $stream,
            "{\"product_name\":\"Margherita\",\"price\":500,\"amount\":1,\"user\":{\"id\":34}}\n",
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

        $response->assertStatus(
            Response::HTTP_OK,
        );

        $response->assertHeader(
            'Content-Type',
            'application/x-ndjson',
        );

        $response->assertHeader(
            'Content-Disposition',
            'attachment; filename=report-' . $report->id . '.jsonl',
        );

        self::assertSame(
            "{\"product_name\":\"Margherita\",\"price\":500,\"amount\":1,\"user\":{\"id\":34}}\n",
            $response->streamedContent(),
        );
    }

    public function test_returns_404_when_report_file_path_is_missing(): void
    {
        $report = Report::factory()->create();

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
        $report = Report::factory()
            ->state([
                'status' => ReportStatus::COMPLETED,
                'file_path' => 'reports/missing.jsonl',
            ])
            ->create();

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

        $response->assertStatus(Response::HTTP_NOT_FOUND);
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

        $response->assertStatus(Response::HTTP_NOT_FOUND);
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
