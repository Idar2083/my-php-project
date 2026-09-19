<?php

declare(strict_types=1);

namespace App\Modules\Auth\Application\Contracts;

interface WelcomeEmailSender
{
    public function send(
        string $eventId,
        string $name,
        string $email,
    ): void;
}
