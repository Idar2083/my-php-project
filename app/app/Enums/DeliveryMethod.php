<?php

declare(strict_types=1);

namespace App\Enums;

enum DeliveryMethod: string
{
    case DELIVERY = 'delivery';

    case PICKUP = 'pickup';
}
