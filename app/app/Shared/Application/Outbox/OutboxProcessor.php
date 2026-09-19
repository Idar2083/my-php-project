<?php

declare(strict_types=1);

namespace App\Shared\Application\Outbox;

use App\Modules\Auth\Domain\Events\UserRegisteredEvent;
use App\Shared\Application\Outbox\Contracts\OutboxEventRepository;
use Illuminate\Support\Facades\Event;

final readonly class OutboxProcessor
{
    private const int BATCH_SIZE = 100;

    public function __construct(
        private OutboxEventRepository $repository,
    ) {
    }

    public function process(): int
    {
        $events = $this->repository->claimPending(
            self::BATCH_SIZE,
        );

        foreach ($events as $event) {
            try {
                Event::dispatch(
                    $this->restoreEvent($event->event_type, $event->payload),
                );

                $this->repository->markPublished($event);
            } catch (\Throwable $exception) {
                $this->repository->markFailed(
                    $event,
                    $exception,
                );
            }
        }

        return count($events);
    }

    /**
     * @param array<string, string|int> $payload
     */
    private function restoreEvent(
        string $eventType,
        array $payload,
    ): UserRegisteredEvent {
        return match ($eventType) {
            UserRegisteredEvent::TYPE => new UserRegisteredEvent(
                eventId: $this->requiredString($payload, 'event_id'),
                userId: $this->requiredInt($payload, 'user_id'),
                name: $this->requiredString($payload, 'name'),
                email: $this->requiredString($payload, 'email'),
                occurredAt: $this->requiredDateTime(
                    $payload,
                    'occurred_at',
                ),
            ),
            default => throw new \RuntimeException(
                sprintf(
                    'Unsupported outbox event type: %s',
                    $eventType,
                ),
            ),
        };
    }

    /**
     * @param array<string, string|int> $payload
     */
    private function requiredString(
        array $payload,
        string $key,
    ): string {
        $value = $payload[$key] ?? null;

        if (!is_string($value) || $value === '') {
            throw new \RuntimeException(
                sprintf(
                    'Invalid outbox event payload: "%s" must be a non-empty string.',
                    $key,
                ),
            );
        }

        return $value;
    }

    /**
     * @param array<string, string|int> $payload
     */
    private function requiredInt(
        array $payload,
        string $key,
    ): int {
        $value = $payload[$key] ?? null;

        if (!is_int($value)) {
            throw new \RuntimeException(
                sprintf(
                    'Invalid outbox event payload: "%s" must be an integer.',
                    $key,
                ),
            );
        }

        return $value;
    }

    /**
     * @param array<string, string|int> $payload
     */
    private function requiredDateTime(
        array $payload,
        string $key,
    ): \DateTimeImmutable {
        $value = $this->requiredString($payload, $key);

        try {
            return new \DateTimeImmutable($value);
        } catch (\Exception $exception) {
            throw new \RuntimeException(sprintf(
                'Invalid outbox event payload: "%s" must be a valid date-time.',
                $key,
            ), $exception->getCode(), previous: $exception);
        }
    }
}
