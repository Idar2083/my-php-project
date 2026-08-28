<?php

declare(strict_types=1);

namespace Tests\Feature\Order;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Cart\Domain\Models\CartItem;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class GetOrderTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    public function test_can_get_own_orders(): void
    {
        $this->addProductToCart();

        $this->createOrder()
            ->assertCreated();

        $this->getJson('/api/orders')
            ->assertOk()
            ->assertJsonCount(1, 'data');
    }

    public function test_can_get_order_by_id(): void
    {
        $this->addProductToCart();

        $orderId = $this->createOrder()
            ->assertCreated()
            ->json('data.id');

        $this->getJson('/api/orders/' . $orderId)
            ->assertOk()
            ->assertJsonPath('data.id', $orderId);
    }

    public function test_cannot_get_another_users_order(): void
    {
        $this->addProductToCart();

        $orderId = $this->createOrder()
            ->assertCreated()
            ->json('data.id');

        $otherUser = User::factory()->create();

        auth('api')->logout();

        $this->withHeader(
            'Authorization',
            'Bearer ' . JWTAuth::fromUser($otherUser),
        )
            ->getJson('/api/orders/' . $orderId)
            ->assertNotFound();
    }

    public function test_guest_cannot_access_orders(): void
    {
        $this->withHeader(
            'Authorization',
            '',
        )
            ->getJson('/api/orders')
            ->assertUnauthorized();
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->user = User::factory()->create();

        $this->withHeader(
            'Authorization',
            'Bearer ' . JWTAuth::fromUser($this->user),
        );
    }

    private function addProductToCart(
        string $name = 'Pepperoni',
        int $quantity = 2,
        int $price = 500,
    ): void {
        $product = Product::query()->create([
            'name' => $name,
            'category' => 'pizza',
            'description' => 'Test product',
            'price' => $price,
            'weight' => 0.55,
        ]);

        $cart = Cart::query()->firstOrCreate([
            'user_id' => $this->user->id,
        ]);

        CartItem::query()->create([
            'cart_id' => $cart->id,
            'product_id' => $product->id,
            'quantity' => $quantity,
        ]);
    }

    private function createOrder()
    {
        return $this->postJson(
            '/api/orders',
            [
                'delivery_method' => 'delivery',
                'region' => 'Moscow Region',
                'city' => 'Moscow',
                'street' => 'Tverskaya',
                'house' => '1',
                'entrance' => '2',
                'apartment' => '10',
                'postal_code' => '125009',
            ],
        );
    }
}
