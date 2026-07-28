<?php

declare(strict_types=1);

namespace App\Enums;

enum OrderStatus: string
{
    case CREATED = 'created';
    case PAID = 'paid';
    case IN_PROCESS = 'in_process';
    case COMPLETED = 'completed';
    case CANCELLED = 'cancelled';
    case DELIVERING = 'delivering';
}
