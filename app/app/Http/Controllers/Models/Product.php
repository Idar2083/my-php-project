<?php

declare(strict_types=1);

namespace App\Http\Controllers\Models;

use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Model;

class Product extends Model
{
    protected $fillable = [
        'name',
        'description',
        'price',
        'weight',
        'category',
    ];

    protected function casts(): array
    {
        return [
            'weight' => 'decimal:3',
        ];
    }
    /**
     * @return Attribute<float, int>
     */
    protected function price(): Attribute
    {
        return Attribute::make(
            get: static fn (int $value): float => $value / 100,
            set: static fn (float $value): int => (int) ($value * 100),
        );
    }
}
