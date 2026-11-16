<?php

declare(strict_types=1);

namespace Tests\Feature\Cart;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\CartItem;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class CartTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    public function test_can_get_empty_cart(): void
    {
        $this->auth()
            ->getJson('/api/cart')
            ->assertOk();
    }

    public function test_can_add_product_to_cart(): void
    {
        $product = $this->createProduct();

        $this->addProduct($product, 2);

        $this->assertDatabaseHas('cart_items', [
            'product_id' => $product->id,
            'quantity' => 2,
        ]);
    }

    public function test_adding_same_product_increases_quantity(): void
    {
        $product = $this->createProduct();

        $this->addProduct($product, 2);
        $this->addProduct($product, 3);

        $this->assertDatabaseHas('cart_items', [
            'product_id' => $product->id,
            'quantity' => 5,
        ]);

        $this->assertDatabaseCount('cart_items', 1);
    }

    public function test_can_update_cart_item_quantity(): void
    {
        $item = $this->addProduct(
            $this->createProduct(),
            2,
        );

        $this->auth()
            ->putJson('/api/cart/items/' . $item->id, [
                'quantity' => 5,
            ])
            ->assertOk();

        $this->assertDatabaseHas('cart_items', [
            'id' => $item->id,
            'quantity' => 5,
        ]);
    }

    public function test_can_remove_cart_item(): void
    {
        $item = $this->addProduct(
            $this->createProduct(),
        );

        $this->auth()
            ->deleteJson('/api/cart/items/' . $item->id)
            ->assertOk();

        $this->assertDatabaseMissing('cart_items', [
            'id' => $item->id,
        ]);
    }

    public function test_can_clear_cart(): void
    {
        $this->addProduct(
            $this->createProduct(),
            2,
        );

        $this->auth()
            ->deleteJson('/api/cart')
            ->assertNoContent();

        $this->assertDatabaseCount('cart_items', 0);
    }

    public function test_can_update_pizza_quantity_to_limit(): void
    {
        $item = $this->addProduct(
            $this->createProduct(),
            2,
        );

        $this->auth()
            ->putJson('/api/cart/items/' . $item->id, [
                'quantity' => 10,
            ])
            ->assertOk();

        $this->assertDatabaseHas('cart_items', [
            'id' => $item->id,
            'quantity' => 10,
        ]);
    }

    public function test_can_update_drink_quantity_to_limit(): void
    {
        $item = $this->addProduct(
            $this->createProduct(
                'Cola',
                'drink',
            ),
            2,
        );

        $this->auth()
            ->putJson('/api/cart/items/' . $item->id, [
                'quantity' => 20,
            ])
            ->assertOk();

        $this->assertDatabaseHas('cart_items', [
            'id' => $item->id,
            'quantity' => 20,
        ]);
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->user = User::factory()->create();
    }

    private function auth(): self
    {
        return $this->withHeader(
            'Authorization',
            'Bearer ' . JWTAuth::fromUser($this->user),
        );
    }

    private function createProduct(
        string $name = 'Pepperoni',
        string $category = 'pizza',
    ): Product {
        return Product::create([
            'name' => $name,
            'category' => $category,
            'description' => 'Test product',
            'price' => 799,
            'weight' => 0.55,
        ]);
    }

    private function addProduct(
        Product $product,
        int $quantity = 1,
    ): CartItem {
        $this->auth()
            ->postJson('/api/cart/items', [
                'product_id' => $product->id,
                'quantity' => $quantity,
            ])
            ->assertOk();

        return CartItem::query()
            ->whereHas('cart', function ($query): void {
                $query->where('user_id', $this->user->id);
            })
            ->where('product_id', $product->id)
            ->firstOrFail();
    }
}
