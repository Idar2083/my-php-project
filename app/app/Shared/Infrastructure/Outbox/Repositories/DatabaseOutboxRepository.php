<?php

declare(strict_types=1);

namespace App\Shared\Infrastructure\Outbox\Repositories;

use App\Shared\Application\Outbox\Contracts\OutboxRepository;
use App\Shared\Infrastructure\Outbox\Models\OutboxEvent;

final class DatabaseOutboxRepository implements OutboxRepository
{
    /**
     * @param array<string, mixed> $payload
     */
    public function add(
        string $eventId,
        string $eventType,
        array $payload,
        \DateTimeInterface $occurredAt,
    ): void {
        OutboxEvent::query()->create([
            'event_id' => $eventId,
            'event_type' => $eventType,
            'payload' => $payload,
            'occurred_at' => $occurredAt,
        ]);
    }
}
