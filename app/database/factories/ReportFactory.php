<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Report>
 */
final class ReportFactory extends Factory
{
    protected $model = Report::class;

    public function definition(): array
    {
        return [
            'status' => ReportStatus::PENDING,
            'date_from' => '2026-08-01 00:00:00',
            'date_to' => '2026-08-24 23:59:59',
            'file_path' => null,
            'error' => null,
        ];
    }
}
