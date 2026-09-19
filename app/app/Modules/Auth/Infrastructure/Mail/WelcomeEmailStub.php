<?php

declare(strict_types=1);

namespace App\Modules\Auth\Infrastructure\Mail;

use App\Modules\Auth\Application\Contracts\WelcomeEmailSender;
use App\Modules\Auth\Infrastructure\Mail\Models\EmailDelivery;
use Illuminate\Support\Facades\Log;

final class WelcomeEmailStub implements WelcomeEmailSender
{
    private const string MESSAGE_TYPE = 'auth.welcome_email';

    public function send(
        string $eventId,
        string $name,
        string $email,
    ): void {
        $now = now();

        $inserted = EmailDelivery::query()->insertOrIgnore([
            'event_id' => $eventId,
            'message_type' => self::MESSAGE_TYPE,
            'recipient' => $email,
            'sent_at' => $now,
            'created_at' => $now,
            'updated_at' => $now,
        ]);

        if ($inserted === 0) {
            return;
        }

        Log::info('Welcome email stub sent.', [
            'event_id' => $eventId,
            'recipient' => $email,
            'name' => $name,
        ]);
    }
}
