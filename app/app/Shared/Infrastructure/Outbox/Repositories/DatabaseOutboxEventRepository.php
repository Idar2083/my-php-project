<?php

declare(strict_types=1);

namespace App\Shared\Infrastructure\Outbox\Repositories;

use App\Shared\Application\Outbox\Contracts\OutboxEventRepository;
use App\Shared\Infrastructure\Outbox\Models\OutboxEvent;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

final class DatabaseOutboxEventRepository implements OutboxEventRepository
{
    private const int PROCESSING_LEASE_MINUTES = 5;

    private const int MAX_ATTEMPTS = 5;

    /**
     * @return list<OutboxEvent>
     */
    public function claimPending(int $limit): array
    {
        if ($limit < 1) {
            return [];
        }

        return DB::transaction(function () use ($limit): array {
            $processingToken = (string) Str::uuid();
            $now = now();
            $staleBefore = $now->copy()->subMinutes(
                self::PROCESSING_LEASE_MINUTES,
            );

            /** @var list<OutboxEvent> $events */
            $events = OutboxEvent::query()
                ->whereNull('published_at')
                ->whereNull('failed_at')
                ->where(function ($query) use ($staleBefore): void {
                    $query
                        ->whereNull('processing_at')
                        ->orWhere('processing_at', '<=', $staleBefore);
                })
                ->orderBy('occurred_at')
                ->orderBy('id')
                ->limit($limit)
                ->lock('FOR UPDATE SKIP LOCKED')
                ->get()
                ->all();

            if ($events === []) {
                return [];
            }

            $eventIds = array_map(
                static fn (OutboxEvent $event): int => $event->getKey(),
                $events,
            );

            OutboxEvent::query()
                ->whereKey($eventIds)
                ->update([
                    'processing_at' => $now,
                    'processing_token' => $processingToken,
                ]);

            foreach ($events as $event) {
                $event->processing_at = $now;
                $event->processing_token = $processingToken;
            }

            return $events;
        });
    }

    public function markPublished(OutboxEvent $event): void
    {
        OutboxEvent::query()
            ->whereKey($event->getKey())
            ->where('processing_token', $event->processing_token)
            ->whereNull('published_at')
            ->whereNull('failed_at')
            ->update([
                'published_at' => now(),
                'last_error' => null,
                'processing_at' => null,
                'processing_token' => null,
            ]);
    }

    public function markFailed(
        OutboxEvent $event,
        \Throwable $exception,
    ): void {
        $attempts = $event->attempts + 1;

        OutboxEvent::query()
            ->whereKey($event->getKey())
            ->where('processing_token', $event->processing_token)
            ->whereNull('published_at')
            ->whereNull('failed_at')
            ->update([
                'attempts' => $attempts,
                'last_error' => $exception->getMessage(),
                'failed_at' => $attempts >= self::MAX_ATTEMPTS
                    ? now()
                    : null,
                'processing_at' => null,
                'processing_token' => null,
            ]);
    }
}
