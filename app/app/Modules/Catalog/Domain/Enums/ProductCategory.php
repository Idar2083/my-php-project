<?php

declare(strict_types=1);

namespace App\Modules\Catalog\Domain\Enums;

enum ProductCategory: string
{
    public static function fromLabel(string $label): ?self
    {
        return self::tryFrom(strtolower(trim($label, ' ')));
    }
    case PIZZA = 'pizza';
    case DRINK = 'drink';
}
