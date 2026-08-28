<?php

declare(strict_types=1);

namespace Tests\Feature\Report;

use App\Modules\Report\Application\Contracts\ReportGenerationPublisher;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

final class CreateReportTest extends TestCase
{
    use RefreshDatabase;

    public function test_can_create_report(): void
    {
        $publisher = $this->mock(ReportGenerationPublisher::class);

        $publisher
            ->shouldReceive('publishGeneration')
            ->once()
            ->with(
                \Mockery::on(
                    static function ($message): bool {
                        return $message->reportId > 0
                            && $message->attempt === 1
                            && $message->dateFrom->format('Y-m-d H:i:s')
                            === '2026-08-01 00:00:00'
                            && $message->dateTo->format('Y-m-d H:i:s')
                            === '2026-08-24 23:59:59';
                    },
                ),
            );

        $response = $this->postJson(
            '/api/reports',
            $this->validReportData(),
        );

        $response->assertStatus(
            Response::HTTP_ACCEPTED,
        )->assertJson([
            'status' => 'pending',
            'date_from' => '2026-08-01T00:00:00.000000Z',
            'date_to' => '2026-08-24T23:59:59.000000Z',
        ])->assertJsonStructure([
            'id',
            'status',
            'date_from',
            'date_to',
        ]);

        $this->assertDatabaseHas(
            'reports',
            [
                'id' => $response->json('id'),
                'status' => 'pending',
                'file_path' => null,
                'error' => null,
            ],
        );
    }

    public function test_cannot_create_report_without_date_from(): void
    {
        $response = $this->postJson(
            '/api/reports',
            [
                'date_to' => '2026-08-24 23:59:59',
            ],
        );

        $response->assertStatus(
            Response::HTTP_UNPROCESSABLE_ENTITY,
        )->assertJsonValidationErrors([
            'date_from',
        ]);

        $this->assertDatabaseCount(
            'reports',
            0,
        );
    }

    public function test_cannot_create_report_without_date_to(): void
    {
        $response = $this->postJson(
            '/api/reports',
            [
                'date_from' => '2026-08-01 00:00:00',
            ],
        );

        $response->assertStatus(
            Response::HTTP_UNPROCESSABLE_ENTITY,
        )->assertJsonValidationErrors([
            'date_to',
        ]);

        $this->assertDatabaseCount(
            'reports',
            0,
        );
    }

    public function test_cannot_create_report_when_date_to_is_before_date_from(): void
    {
        $response = $this->postJson(
            '/api/reports',
            [
                'date_from' => '2026-08-24 23:59:59',
                'date_to' => '2026-08-01 00:00:00',
            ],
        );

        $response->assertStatus(
            Response::HTTP_UNPROCESSABLE_ENTITY,
        )->assertJsonValidationErrors([
            'date_to',
        ]);

        $this->assertDatabaseCount(
            'reports',
            0,
        );
    }

    public function test_report_is_marked_failed_when_generation_message_cannot_be_published(): void
    {
        $publisher = $this->mock(ReportGenerationPublisher::class);

        $publisher
            ->shouldReceive('publishGeneration')
            ->once()
            ->andThrow(
                new \RuntimeException('RabbitMQ is unavailable.'),
            );

        $response = $this->postJson(
            '/api/reports',
            $this->validReportData(),
        );

        $response->assertStatus(
            Response::HTTP_INTERNAL_SERVER_ERROR,
        );

        $this->assertDatabaseHas(
            'reports',
            [
                'status' => 'failed',
                'error' => 'RabbitMQ is unavailable.',
            ],
        );
    }

    /**
     * @return array{
     *     date_from: string,
     *     date_to: string
     * }
     */
    private function validReportData(): array
    {
        return [
            'date_from' => '2026-08-01 00:00:00',
            'date_to' => '2026-08-24 23:59:59',
        ];
    }
}
