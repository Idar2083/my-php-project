<?php

namespace App\Http\Controllers\Models;

use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Casts\Attribute;

class Product extends Model
{
    protected $fillable = [
        'name',
        'description',
        'price',
        'weight',
        'category',
    ];

    protected function casts():array
    {
        return [
            'weight' => 'decimal:3',
        ];
    }

    protected function price(): Attribute
    {
        return Attribute::make(
            get: static fn (int $value) => $value / 100,
            set: static fn (float $value) => (int) ($value * 100),
        );
    }
}
