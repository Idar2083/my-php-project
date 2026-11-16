<?php

declare(strict_types=1);

namespace App\Modules\Auth\Domain\Enums;

enum UserRole: string
{
    case ADMIN = 'admin';
    case USER = 'user';
}
