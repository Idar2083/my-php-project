<?php

declare(strict_types=1);

namespace Database\Factories;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use Illuminate\Database\Eloquent\Factories\Factory;

/**
 * @extends Factory<Cart>
 */
final class CartFactory extends Factory
{
    protected $model = Cart::class;

    public function definition(): array
    {
        return [
            'user_id' => User::factory(),
        ];
    }
}
