<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging\Console;

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
        $dateTo = $dateFrom->copy();

        try {
            $report = $handler->handle(
                dateFrom: $dateFrom,
                dateTo: $dateTo,
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
