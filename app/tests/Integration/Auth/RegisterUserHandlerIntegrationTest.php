<?php

declare(strict_types=1);

namespace Tests\Integration\Auth;

use App\Modules\Auth\Application\Handlers\RegisterUserHandler;
use App\Shared\Application\Outbox\Contracts\OutboxRepository;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class RegisterUserHandlerIntegrationTest extends TestCase
{
    use RefreshDatabase;

    public function test_registration_creates_user_and_outbox_event_atomically(): void
    {
        $handler = app(RegisterUserHandler::class);

        $user = $handler->handle(
            name: 'John Doe',
            email: 'john@example.com',
            password: 'Password1!',
        );

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'name' => 'John Doe',
            'email' => 'john@example.com',
        ]);

        $this->assertDatabaseHas('outbox_events', [
            'event_type' => 'auth.user_registered',
        ]);

        $this->assertDatabaseCount('outbox_events', 1);

        $event = \DB::table('outbox_events')->first();

        $this->assertNotNull($event);

        $payload = json_decode(
            $event->payload,
            true,
            512,
            JSON_THROW_ON_ERROR,
        );

        $this->assertSame(
            (string) $event->event_id,
            $payload['event_id'],
        );

        $this->assertSame(
            $user->id,
            $payload['user_id'],
        );

        $this->assertSame(
            'John Doe',
            $payload['name'],
        );

        $this->assertSame(
            'john@example.com',
            $payload['email'],
        );
    }

    public function test_registration_rolls_back_user_and_outbox_event_when_outbox_write_fails(): void
    {
        $this->app->instance(
            OutboxRepository::class,
            new class () implements OutboxRepository {
                public function add(
                    string $eventId,
                    string $eventType,
                    array $payload,
                    \DateTimeInterface $occurredAt,
                ): void {
                    throw new \RuntimeException(
                        'Outbox write failed.',
                    );
                }
            },
        );

        $handler = app(RegisterUserHandler::class);

        $this->expectException(\RuntimeException::class);
        $this->expectExceptionMessage('Outbox write failed.');

        try {
            $handler->handle(
                name: 'John Doe',
                email: 'john@example.com',
                password: 'Password1!',
            );
        } finally {
            $this->assertDatabaseMissing('users', [
                'email' => 'john@example.com',
            ]);

            $this->assertDatabaseCount('outbox_events', 0);
        }
    }
}
