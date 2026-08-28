<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Handlers;

use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\DTO\ReportCompletedMessage;
use App\Modules\Report\Application\DTO\ReportGenerationMessage;
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

    public function handle(ReportGenerationMessage $message): void
    {
        $report = Report::query()->find($message->reportId);

        if ($report === null) {
            throw new \RuntimeException(
                sprintf(
                    'Report with ID %d was not found.',
                    $message->reportId,
                ),
            );
        }

        if ($report->status === ReportStatus::COMPLETED) {
            $this->publishCompleted(
                message: $message,
                report: $report,
            );

            return;
        }

        if ($report->status === ReportStatus::FAILED) {
            throw new \RuntimeException(
                sprintf(
                    'Report %d has already failed.',
                    $report->id,
                ),
            );
        }

        $this->startProcessing($report);

        $this->generationService->generate($report);

        $report->refresh();

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
            message: $message,
            report: $report,
        );
    }

    private function startProcessing(Report $report): void
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

        if ($started === 0) {
            throw new \RuntimeException(
                sprintf(
                    'Report %d is already being processed.',
                    $report->id,
                ),
            );
        }

        $report->refresh();
    }

    private function publishCompleted(
        ReportGenerationMessage $message,
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
                messageId: $message->messageId . ':completed',
                reportId: $report->id,
                filePath: $report->file_path,
                createdAt: new \DateTimeImmutable(),
            ),
        );
    }
}
