<?php

namespace App\Http\Controllers\Models;

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

    protected function casts():array
    {
        return [
            'price' => 'decimal',
            'weight' => 'decimal',
        ];
    }

}
