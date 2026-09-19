<?php

declare(strict_types=1);

namespace App\Modules\Auth\Application\Listeners;

use App\Modules\Auth\Application\Contracts\WelcomeEmailSender;
use App\Modules\Auth\Domain\Events\UserRegisteredEvent;

final readonly class SendWelcomeEmail
{
    public function __construct(
        private WelcomeEmailSender $emailSender,
    ) {
    }

    public function handle(UserRegisteredEvent $event): void
    {
        $this->emailSender->send(
            eventId: $event->eventId,
            name: $event->name,
            email: $event->email,
        );
    }
}
