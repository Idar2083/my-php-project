<?php

declare(strict_types=1);

namespace Tests\Integration\Auth;

use App\Modules\Auth\Application\Handlers\RegisterUserHandler;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Artisan;
use Tests\TestCase;

final class UserRegisteredOutboxIntegrationTest extends TestCase
{
    use RefreshDatabase;

    public function test_user_registered_event_is_processed_and_welcome_email_is_sent_once(): void
    {
        $handler = app(RegisterUserHandler::class);

        $user = $handler->handle(
            name: 'John Doe',
            email: 'john@example.com',
            password: 'Password1!',
        );

        $this->assertDatabaseCount('outbox_events', 1);
        $this->assertDatabaseCount('email_deliveries', 0);

        $exitCode = Artisan::call('outbox:process');

        $this->assertSame(
            0,
            $exitCode,
            Artisan::output(),
        );

        $this->assertDatabaseHas('outbox_events', [
            'event_type' => 'auth.user_registered',
        ]);

        $this->assertDatabaseCount('email_deliveries', 1);

        $delivery = \DB::table('email_deliveries')->first();

        $this->assertNotNull($delivery);

        $this->assertSame(
            'auth.welcome_email',
            $delivery->message_type,
        );

        $this->assertSame(
            'john@example.com',
            $delivery->recipient,
        );

        $this->assertNotNull($delivery->sent_at);

        $this->assertDatabaseCount('outbox_events', 1);

        $exitCode = Artisan::call('outbox:process');

        $this->assertSame(
            0,
            $exitCode,
            Artisan::output(),
        );

        $this->assertDatabaseCount('email_deliveries', 1);

        $this->assertDatabaseHas('users', [
            'id' => $user->id,
            'email' => 'john@example.com',
        ]);

        $event = \DB::table('outbox_events')->first();

        $this->assertNotNull($event);
        $this->assertNotNull($event->published_at);
        $this->assertNull($event->failed_at);
        $this->assertSame(0, $event->attempts);
    }
}
