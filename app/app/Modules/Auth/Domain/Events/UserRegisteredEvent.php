<?php

declare(strict_types=1);

namespace App\Modules\Auth\Domain\Events;

final readonly class UserRegisteredEvent
{
    public const string TYPE = 'auth.user_registered';

    public function __construct(
        public string $eventId,
        public int $userId,
        public string $name,
        public string $email,
        public \DateTimeImmutable $occurredAt,
    ) {
    }

    /**
     * @return array<string, scalar>
     */
    public function payload(): array
    {
        return [
            'event_id' => $this->eventId,
            'user_id' => $this->userId,
            'name' => $this->name,
            'email' => $this->email,
            'occurred_at' => $this->occurredAt->format(\DateTimeInterface::ATOM),
        ];
    }
}
