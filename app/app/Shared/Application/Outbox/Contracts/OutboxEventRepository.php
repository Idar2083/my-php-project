<?php

declare(strict_types=1);

namespace App\Shared\Application\Outbox\Contracts;

use App\Shared\Infrastructure\Outbox\Models\OutboxEvent;

interface OutboxEventRepository
{
    /**
     * @return list<OutboxEvent>
     */
    public function claimPending(int $limit): array;

    public function markPublished(OutboxEvent $event): void;

    public function markFailed(
        OutboxEvent $event,
        \Throwable $exception,
    ): void;
}
