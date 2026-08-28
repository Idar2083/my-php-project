<?php

declare(strict_types=1);

namespace App\Modules\Report\Presentation\Controllers;

use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Application\Handlers\CreateReportHandler;
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
        $report = $handler->handle(
            dateFrom: $request->string('date_from')->toString(),
            dateTo: $request->string('date_to')->toString(),
        );

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

    public function show(int $id): JsonResponse
    {
        $report = Report::query()->findOrFail($id);

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
        int $id,
        ReportStorage $storage,
    ): StreamedResponse {
        $report = Report::query()->findOrFail($id);

        if (
            $report->file_path === null
            || !$storage->exists($report->file_path)
        ) {
            abort(Response::HTTP_NOT_FOUND);
        }

        $stream = $storage->readStream($report->file_path);

        return response()->streamDownload(
            static function () use ($stream): void {
                $output = fopen('php://output', 'wb');

                if ($output === false) {
                    fclose($stream);

                    throw new \RuntimeException(
                        'Unable to open output stream.',
                    );
                }

                try {
                    stream_copy_to_stream(
                        $stream,
                        $output,
                    );
                } finally {
                    fclose($output);
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
