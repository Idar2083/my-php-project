<?php

declare(strict_types=1);

namespace App\Modules\Report\Presentation\Controllers;

use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Application\Handlers\CreateReportHandler;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use App\Modules\Report\Presentation\Requests\CreateReportRequest;
use Illuminate\Http\JsonResponse;
use Illuminate\Support\Facades\Log;
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
            Log::error('Report creation failed.', [
                'exception_class' => $exception::class,
                'exception_code' => $exception->getCode(),
                'source_file' => $exception->getFile(),
                'source_line' => $exception->getLine(),
            ]);

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
            'error' => $report->error === null ? null : __('api.report.generation_unavailable'),
        ]);
    }

    public function download(
        Report $report,
        ReportStorage $storage,
    ): StreamedResponse|JsonResponse {
        if (
            $report->status !== ReportStatus::COMPLETED
            || $report->file_path === null
        ) {
            abort(
                Response::HTTP_NOT_FOUND,
                __('api.report.file_unavailable'),
            );
        }

        try {
            $exists = $storage->exists($report->file_path);
            $stream = $exists ? $storage->readStream($report->file_path) : null;
        } catch (\Throwable $exception) {
            Log::error('Report download failed.', [
                'report_id' => $report->id,
                'exception_class' => $exception::class,
                'exception_code' => $exception->getCode(),
                'source_file' => $exception->getFile(),
                'source_line' => $exception->getLine(),
            ]);

            return response()->json(['message' => __('api.report.generation_unavailable')], Response::HTTP_SERVICE_UNAVAILABLE);
        }

        if (!$exists) {
            abort(
                Response::HTTP_NOT_FOUND,
                __('api.report.file_missing'),
            );
        }

        return response()->streamDownload(
            static function () use ($stream): void {
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
