<?php

declare(strict_types=1);

namespace Tests\Feature\Report;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Report\Application\Jobs\GenerateReportJob;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class CreateReportTest extends TestCase
{
    use RefreshDatabase;

    private User $admin;

    public function test_can_create_report(): void
    {
        Queue::fake();

        $response = $this->postJson(
            '/api/reports',
            $this->validReportData(),
        );

        $response
            ->assertStatus(Response::HTTP_ACCEPTED)
            ->assertJson([
                'status' => 'pending',
                'date_from' => '2026-08-01T00:00:00.000000Z',
                'date_to' => '2026-08-24T00:00:00.000000Z',
            ])
            ->assertJsonStructure([
                'id',
                'status',
                'date_from',
                'date_to',
            ]);

        $reportId = $response->json('id');

        $this->assertDatabaseHas(
            'reports',
            [
                'id' => $reportId,
                'status' => 'pending',
                'file_path' => null,
                'error' => null,
            ],
        );

        Queue::assertPushed(
            GenerateReportJob::class,
            1,
        );
    }

    public function test_cannot_create_report_without_date_from(): void
    {
        Queue::fake();

        $response = $this->postJson(
            '/api/reports',
            [
                'date_to' => '2026-08-24',
            ],
        );

        $response
            ->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
            ->assertJsonValidationErrors([
                'date_from',
            ]);

        $this->assertDatabaseCount(
            'reports',
            0,
        );

        Queue::assertNothingPushed();
    }

    public function test_cannot_create_report_without_date_to(): void
    {
        Queue::fake();

        $response = $this->postJson(
            '/api/reports',
            [
                'date_from' => '2026-08-01',
            ],
        );

        $response
            ->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
            ->assertJsonValidationErrors([
                'date_to',
            ]);

        $this->assertDatabaseCount(
            'reports',
            0,
        );

        Queue::assertNothingPushed();
    }

    public function test_cannot_create_report_when_date_to_is_before_date_from(): void
    {
        Queue::fake();

        $response = $this->postJson(
            '/api/reports',
            [
                'date_from' => '2026-08-24',
                'date_to' => '2026-08-01',
            ],
        );

        $response
            ->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
            ->assertJsonValidationErrors([
                'date_to',
            ]);

        $this->assertDatabaseCount(
            'reports',
            0,
        );

        Queue::assertNothingPushed();
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

    /**
     * @return array{
     *     date_from: string,
     *     date_to: string
     * }
     */
    private function validReportData(): array
    {
        return [
            'date_from' => '2026-08-01',
            'date_to' => '2026-08-24',
        ];
    }
}
