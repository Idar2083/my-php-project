<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Handlers;

use App\Modules\Report\Application\Jobs\GenerateReportJob;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

final readonly class CreateReportHandler
{
    public function handle(
        \DateTimeInterface $dateFrom,
        \DateTimeInterface $dateTo,
    ): Report {
        return DB::transaction(
            function () use ($dateFrom, $dateTo): Report {
                $report = Report::query()->create([
                    'status' => ReportStatus::PENDING,
                    'date_from' => $dateFrom,
                    'date_to' => $dateTo,
                ]);

                GenerateReportJob::dispatch(
                    reportId: $report->id,
                    messageId: (string) Str::uuid(),
                );

                return $report;
            },
        );
    }
}
