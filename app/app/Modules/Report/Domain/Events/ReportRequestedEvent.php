<?php

declare(strict_types=1);

namespace App\Modules\Report\Domain\Events;

final readonly class ReportRequestedEvent
{
    public const string TYPE = 'reports.requested';

    public function __construct(
        public string $eventId,
        public int $reportId,
        public \DateTimeImmutable $occurredAt,
    ) {
    }

    /** @return array<string, string|int> */
    public function payload(): array
    {
        return [
            'event_id' => $this->eventId,
            'report_id' => $this->reportId,
            'occurred_at' => $this->occurredAt->format(\DateTimeInterface::ATOM),
        ];
    }
}
