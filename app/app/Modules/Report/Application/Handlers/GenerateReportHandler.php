<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Handlers;

use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\DTO\ReportCompletedMessage;
use App\Modules\Report\Application\Services\ReportGenerationService;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;

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
        $report = Report::query()->find($reportId);

        if ($report === null) {
            throw new \RuntimeException(
                sprintf(
                    'Report with ID %d was not found.',
                    $reportId,
                ),
            );
        }

        if ($report->status === ReportStatus::COMPLETED) {
            $this->publishCompleted(
                messageId: $messageId,
                report: $report,
            );

            return;
        }

        if ($report->status === ReportStatus::FAILED) {
            return;
        }

        if (!$this->startProcessing($report)) {
            $report->refresh();

            if ($report->status === ReportStatus::PROCESSING) {
                return;
            }

            if ($report->status === ReportStatus::COMPLETED) {
                $this->publishCompleted(
                    messageId: $messageId,
                    report: $report,
                );

                return;
            }

            if ($report->status === ReportStatus::FAILED) {
                return;
            }

            throw new \RuntimeException(
                sprintf(
                    'Report %d is in invalid status: %s.',
                    $report->id,
                    $report->status->value,
                ),
            );
        }

        /*
         * startProcessing() updates the database directly, so the
         * in-memory model still contains the old PENDING status.
         * Reload it before passing it to the generation service.
         */
        $report->refresh();

        $this->generationService->generate($report);

        if (
            $report->status !== ReportStatus::COMPLETED
            || $report->file_path === null
        ) {
            throw new \RuntimeException(
                sprintf(
                    'Report %d was not completed successfully.',
                    $report->id,
                ),
            );
        }

        $this->publishCompleted(
            messageId: $messageId,
            report: $report,
        );
    }

    private function startProcessing(Report $report): bool
    {
        $started = Report::query()
            ->whereKey($report->id)
            ->where(
                'status',
                ReportStatus::PENDING->value,
            )
            ->update([
                'status' => ReportStatus::PROCESSING->value,
                'error' => null,
            ]);

        return $started === 1;
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
