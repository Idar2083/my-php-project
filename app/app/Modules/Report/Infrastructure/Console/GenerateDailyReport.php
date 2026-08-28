<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Console;

use App\Modules\Report\Application\Handlers\CreateReportHandler;
use Illuminate\Console\Command;

final class GenerateDailyReport extends Command
{
    protected $signature = 'reports:generate-daily';

    protected $description = 'Create a report for the previous day';

    public function handle(CreateReportHandler $handler): int
    {
        $date = now()->subDay();

        $dateFrom = $date->copy()->startOfDay();
        $dateTo = $date->copy()->endOfDay();

        try {
            $report = $handler->handle(
                dateFrom: $dateFrom->toDateTimeString(),
                dateTo: $dateTo->toDateTimeString(),
            );

            $this->info(
                sprintf(
                    'Report #%d created for %s - %s.',
                    $report->id,
                    $dateFrom->toDateTimeString(),
                    $dateTo->toDateTimeString(),
                ),
            );

            return self::SUCCESS;
        } catch (\Throwable $exception) {
            $this->error($exception->getMessage());

            report($exception);

            return self::FAILURE;
        }
    }
}
