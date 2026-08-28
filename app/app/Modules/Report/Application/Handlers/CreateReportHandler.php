<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Handlers;

use App\Modules\Report\Application\Contracts\ReportGenerationPublisher;
use App\Modules\Report\Application\DTO\ReportGenerationMessage;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Support\Str;

final readonly class CreateReportHandler
{
    public function __construct(
        private ReportGenerationPublisher $publisher,
    ) {
    }

    public function handle(
        string $dateFrom,
        string $dateTo,
    ): Report {
        $report = Report::query()->create([
            'status' => ReportStatus::PENDING,
            'date_from' => $dateFrom,
            'date_to' => $dateTo,
        ]);

        try {
            $message = new ReportGenerationMessage(
                messageId: (string) Str::uuid(),
                reportId: $report->id,
                dateFrom: new \DateTimeImmutable($dateFrom),
                dateTo: new \DateTimeImmutable($dateTo),
                createdAt: new \DateTimeImmutable(),
            );

            $this->publisher->publishGeneration($message);
        } catch (\Throwable $exception) {
            $report->update([
                'status' => ReportStatus::FAILED,
                'error' => $exception->getMessage(),
            ]);

            throw $exception;
        }

        return $report;
    }
}
