<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Handlers;

use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\DTO\ReportCompletedMessage;
use App\Modules\Report\Application\Exceptions\PermanentReportGenerationException;
use App\Modules\Report\Application\Services\ReportGenerationService;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Support\Facades\DB;

final readonly class GenerateReportHandler
{
    public function __construct(
        private ReportGenerationService $generationService,
        private ReportCompletionPublisher $publisher,
    ) {
    }

    public function handle(
        int $reportId,
        string $messageId,
    ): void {
        // The row lock is the processing lease. It has no clock expiry: a live
        // generator keeps ownership; process death rolls back and releases it.
        // Legacy PROCESSING rows without a live lock can be reclaimed as well.
        $result = DB::transaction(function () use ($reportId): Report|\Throwable {
            $report = Report::query()->lockForUpdate()->find($reportId);
            if ($report === null) {
                throw new \RuntimeException(sprintf('Report with ID %d was not found.', $reportId));
            }
            if ($report->status === ReportStatus::COMPLETED) {
                return $report;
            }
            if ($report->status === ReportStatus::FAILED) {
                return new PermanentReportGenerationException('Report generation has permanently failed.');
            }
            $report->status = ReportStatus::PROCESSING;
            $report->error = null;
            $report->save();
            try {
                $this->generationService->generate($report);
            } catch (\Throwable $exception) {
                // Commit the retryable/terminal state before rethrowing to the
                // queue worker; throwing here would roll back that state too.
                return $exception;
            }

            return $report;
        });
        if ($result instanceof \Throwable) {
            throw $result;
        }
        // Publication failure retries only completion, never regenerates a file.
        $this->publishCompleted($messageId, $result);
    }

    private function publishCompleted(
        string $messageId,
        Report $report,
    ): void {
        if ($report->file_path === null) {
            throw new \RuntimeException(
                sprintf(
                    'Report %d does not have a generated file.',
                    $report->id,
                ),
            );
        }

        $this->publisher->publishCompleted(
            new ReportCompletedMessage(
                messageId: $messageId . ':completed',
                reportId: $report->id,
                filePath: $report->file_path,
                createdAt: new \DateTimeImmutable(),
            ),
        );
    }
}
