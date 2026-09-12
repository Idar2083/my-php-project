<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Jobs;

use App\Modules\Report\Application\Handlers\GenerateReportHandler;
use Illuminate\Bus\Queueable;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Bus\Dispatchable;
use Illuminate\Queue\InteractsWithQueue;

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
        $handler->handle(
            reportId: $this->reportId,
            messageId: $this->messageId,
        );
    }
}
