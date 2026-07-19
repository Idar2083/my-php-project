<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Http\Controllers\Models\Cart;
use App\Http\Controllers\Models\CartItem;
use App\Http\Controllers\Models\Product;
use App\Http\Controllers\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

class OrderTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    protected function setUp(): void
    {
        parent::setUp();

        $this->user = User::factory()->create();

        $this->withHeader(
            'Authorization',
            'Bearer ' . JWTAuth::fromUser($this->user),
        );
    }

    /**
     * @return array<string, string>
     */
    private function address(): array
    {
        return [
            'region' => 'Moscow Region',
            'city' => 'Moscow',
            'street' => 'Tverskaya',
            'house' => '1',
            'entrance' => '2',
            'apartment' => '10',
            'postal_code' => '125009',
        ];
    }

    private function addProductToCart(
        string $name = 'Pepperoni',
        int $quantity = 2,
        int $price = 500,
    ): Product {
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

        return $product;
    }

    private function createOrder(): TestResponse
    {
        return $this->postJson(
            '/api/orders',
            $this->address(),
        );
    }

    public function test_can_create_order(): void
    {
        $product = $this->addProductToCart(
            quantity: 2,
            price: 500,
        );

        $this->createOrder()
            ->assertCreated();

        $this->assertDatabaseHas('orders', [
            'user_id' => $this->user->id,
            'status' => 'created',
            'total_price' => 1_000,
            'region' => 'Moscow Region',
            'city' => 'Moscow',
            'street' => 'Tverskaya',
            'house' => '1',
            'entrance' => '2',
            'apartment' => '10',
            'postal_code' => '125009',
        ]);

        $this->assertDatabaseHas('order_items', [
            'product_id' => $product->id,
            'quantity' => 2,
            'price' => 500,
        ]);

        $this->assertDatabaseCount('cart_items', 0);
    }

    public function test_order_total_is_calculated_from_multiple_products(): void
    {
        $this->addProductToCart(
            name: 'Pepperoni',
            quantity: 2,
            price: 500,
        );

        $this->addProductToCart(
            name: 'Cola',
            quantity: 3,
            price: 200,
        );

        $this->createOrder()
            ->assertCreated();

        $this->assertDatabaseHas('orders', [
            'user_id' => $this->user->id,
            'total_price' => 1_600,
        ]);

        $this->assertDatabaseCount('order_items', 2);
    }

    public function test_cannot_create_order_without_cart(): void
    {
        $this->createOrder()
            ->assertUnprocessable()
            ->assertJsonValidationErrors('cart');

        $this->assertDatabaseCount('orders', 0);
    }

    public function test_cannot_create_order_with_empty_cart(): void
    {
        Cart::query()->create([
            'user_id' => $this->user->id,
        ]);

        $this->createOrder()
            ->assertUnprocessable()
            ->assertJsonValidationErrors('cart');

        $this->assertDatabaseCount('orders', 0);
    }

    public function test_cannot_create_order_with_invalid_address(): void
    {
        $this->addProductToCart();

        $this->postJson('/api/orders', [])
            ->assertUnprocessable()
            ->assertJsonValidationErrors([
                'region',
                'city',
                'street',
                'house',
                'postal_code',
            ]);

        $this->assertDatabaseCount('orders', 0);
    }

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
        )->getJson('/api/orders/' . $orderId)
            ->assertNotFound();
    }

    public function test_guest_cannot_access_orders(): void
    {
        $this->withHeader('Authorization', '');

        $this->getJson('/api/orders')
            ->assertUnauthorized();
    }
}
