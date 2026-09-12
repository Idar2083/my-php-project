<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Product>
 */
final class ProductFactory extends Factory
{
    protected $model = Product::class;

    public function definition(): array
    {
        return [
            'name' => 'Pepperoni',
            'category' => 'pizza',
            'description' => 'Test product',
            'price' => 500,
            'weight' => 0.55,
        ];
    }
}
