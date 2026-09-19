<?php

declare(strict_types=1);

namespace App\Modules\Auth\Application\Handlers;

use App\Modules\Auth\Domain\Events\UserRegisteredEvent;
use App\Modules\Auth\Domain\Models\User;
use App\Shared\Application\Outbox\Contracts\OutboxRepository;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

final readonly class RegisterUserHandler
{
    public function __construct(
        private OutboxRepository $outboxRepository,
    ) {
    }

    public function handle(
        string $name,
        string $email,
        string $password,
    ): User {
        return DB::transaction(function () use (
            $name,
            $email,
            $password,
        ): User {
            $user = User::query()->create([
                'name' => $name,
                'email' => $email,
                'password' => $password,
            ]);

            $event = new UserRegisteredEvent(
                eventId: (string) Str::uuid(),
                userId: $user->getKey(),
                name: $user->name,
                email: $user->email,
                occurredAt: now()->toImmutable(),
            );

            $this->outboxRepository->add(
                eventId: $event->eventId,
                eventType: UserRegisteredEvent::TYPE,
                payload: $event->payload(),
                occurredAt: $event->occurredAt,
            );

            return $user;
        });
    }
}
