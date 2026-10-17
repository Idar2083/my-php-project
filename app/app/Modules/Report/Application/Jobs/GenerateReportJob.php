<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Jobs;

use App\Modules\Report\Application\Exceptions\PermanentReportGenerationException;
use App\Modules\Report\Application\Handlers\GenerateReportHandler;
use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;
use Illuminate\Support\Facades\DB;

final class GenerateReportJob implements ShouldQueue
{
    use Dispatchable;
    use InteractsWithQueue;
    use Queueable;

    public int $tries = 3;

    public int $backoff = 60;

    public function __construct(
        private readonly int $reportId,
        private readonly string $messageId,
    ) {
        $this->onConnection('rabbitmq');
        $this->onQueue(
            (string) config('queue.connections.rabbitmq.queue'),
        );
    }

    public function handle(
        GenerateReportHandler $handler,
    ): void {
        try {
            $handler->handle(
                reportId: $this->reportId,
                messageId: $this->messageId,
            );
        } catch (PermanentReportGenerationException $exception) {
            $this->fail($exception);
        }
    }

    public function failed(?\Throwable $exception): void
    {
        DB::transaction(function (): void {
            $report = Report::query()->lockForUpdate()->find($this->reportId);
            if ($report !== null && $report->status !== ReportStatus::COMPLETED && $report->status !== ReportStatus::FAILED) {
                $report->status = ReportStatus::FAILED;
                $report->error = 'Report job exhausted its attempts.';
                $report->save();
            }
        });
    }
}
