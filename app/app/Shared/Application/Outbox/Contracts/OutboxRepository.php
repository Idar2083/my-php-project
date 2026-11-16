<?php

declare(strict_types=1);

namespace App\Shared\Application\Outbox\Contracts;

interface OutboxRepository
{
    /**
     * @param array<string, mixed> $payload
     */
    public function add(
        string $eventId,
        string $eventType,
        array $payload,
        \DateTimeInterface $occurredAt,
    ): void;
}
