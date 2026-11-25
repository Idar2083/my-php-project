<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Handlers;

use App\Modules\Report\Domain\Enums\ReportStatus;
use App\Modules\Report\Domain\Events\ReportRequestedEvent;
use App\Modules\Report\Domain\Models\Report;
use App\Shared\Application\Outbox\Contracts\OutboxRepository;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

final readonly class CreateReportHandler
{
    public function __construct(private OutboxRepository $outbox)
    {
    }

    public function handle(
        \DateTimeInterface $dateFrom,
        \DateTimeInterface $dateTo,
    ): Report {
        return DB::transaction(
            function () use ($dateFrom, $dateTo): Report {
                $report = Report::query()->create([
                    'status' => ReportStatus::PENDING,
                    'date_from' => $dateFrom,
                    'date_to' => $dateTo,
                ]);

                $event = new ReportRequestedEvent((string) Str::uuid(), $report->id, now()->toImmutable());
                $this->outbox->add($event->eventId, ReportRequestedEvent::TYPE, $event->payload(), $event->occurredAt);

                return $report;
            },
        );
    }
}
