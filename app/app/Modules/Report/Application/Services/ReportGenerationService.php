<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Services;

use App\Modules\Report\Application\Contracts\ReportOrderItemReader;
use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;

final readonly class ReportGenerationService
{
    public function __construct(
        private ReportOrderItemReader $orderItemReader,
        private JsonlReportWriter $writer,
        private ReportStorage $storage,
    ) {
    }

    public function generate(Report $report): void
    {
        if ($report->status !== ReportStatus::PROCESSING) {
            throw new \RuntimeException(
                sprintf(
                    'Report %d must be in processing status.',
                    $report->id,
                ),
            );
        }

        $temporaryPath = tempnam(
            sys_get_temp_dir(),
            'report_',
        );

        if ($temporaryPath === false) {
            throw new \RuntimeException(
                'Unable to create temporary report file.',
            );
        }

        try {
            $rows = $this->orderItemReader->between(
                dateFrom: $report->date_from,
                dateTo: $report->date_to,
            );

            $this->writer->write(
                rows: $rows,
                path: $temporaryPath,
            );

            $storagePath = sprintf(
                'reports/%d.jsonl',
                $report->id,
            );

            $stream = fopen(
                $temporaryPath,
                'rb',
            );

            if ($stream === false) {
                throw new \RuntimeException(
                    'Unable to open generated report for upload.',
                );
            }

            try {
                $this->storage->put(
                    path: $storagePath,
                    stream: $stream,
                );
            } finally {
                fclose($stream);
            }

            $report->update([
                'status' => ReportStatus::COMPLETED,
                'file_path' => $storagePath,
                'error' => null,
            ]);
        } catch (\Throwable $exception) {
            throw $exception;
        } finally {
            if (
                is_file($temporaryPath)
            ) {
                unlink($temporaryPath);
            }
        }
    }
}
