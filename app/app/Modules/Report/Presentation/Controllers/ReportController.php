<?php

declare(strict_types=1);

namespace App\Modules\Report\Presentation\Controllers;

use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Application\Handlers\CreateReportHandler;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use App\Modules\Report\Presentation\Requests\CreateReportRequest;
use Illuminate\Http\JsonResponse;
use Symfony\Component\HttpFoundation\Response;
use Symfony\Component\HttpFoundation\StreamedResponse;

final class ReportController
{
    public function store(
        CreateReportRequest $request,
        CreateReportHandler $handler,
    ): JsonResponse {
        try {
            $report = $handler->handle(
                dateFrom: $request->normalizedDateFrom(),
                dateTo: $request->normalizedDateTo(),
            );
        } catch (\Throwable $exception) {
            report($exception);

            return response()->json(
                [
                    'message' => __('api.report.generation_unavailable'),
                ],
                Response::HTTP_SERVICE_UNAVAILABLE,
            );
        }

        return response()->json(
            [
                'id' => $report->id,
                'status' => $report->status->value,
                'date_from' => $report->date_from->toISOString(),
                'date_to' => $report->date_to->toISOString(),
            ],
            Response::HTTP_ACCEPTED,
        );
    }

    public function show(Report $report): JsonResponse
    {
        return response()->json([
            'id' => $report->id,
            'status' => $report->status->value,
            'date_from' => $report->date_from->toISOString(),
            'date_to' => $report->date_to->toISOString(),
            'file_path' => $report->file_path,
            'error' => $report->error,
        ]);
    }

    public function download(
        Report $report,
        ReportStorage $storage,
    ): StreamedResponse {
        if (
            $report->status !== ReportStatus::COMPLETED
            || $report->file_path === null
        ) {
            abort(
                Response::HTTP_NOT_FOUND,
                __('api.report.file_unavailable'),
            );
        }

        if (!$storage->exists($report->file_path)) {
            abort(
                Response::HTTP_NOT_FOUND,
                __('api.report.file_missing'),
            );
        }

        $filePath = $report->file_path;

        return response()->streamDownload(
            static function () use ($storage, $filePath): void {
                $stream = $storage->readStream($filePath);

                try {
                    fpassthru($stream);
                } finally {
                    fclose($stream);
                }
            },
            sprintf('report-%d.jsonl', $report->id),
            [
                'Content-Type' => 'application/x-ndjson',
            ],
        );
    }
}
