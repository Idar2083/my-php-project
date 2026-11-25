<?php

declare(strict_types=1);

namespace Tests\Feature\Cart;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
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

    public function test_guest_cart_import_requires_authentication(): void
    {
        $this->postJson('/api/cart/import', ['items' => [
            ['product_id' => $this->createProduct()->id, 'quantity' => 1],
        ]])->assertUnauthorized();

        $this->assertDatabaseCount('cart_items', 0);
    }

    public function test_guest_cart_import_preserves_larger_quantities_and_can_be_retried(): void
    {
        $product = $this->createProduct();
        $other = $this->createProduct();
        $this->addProduct($product, 4);
        $items = [
            ['product_id' => $product->id, 'quantity' => 2],
            ['product_id' => (string) $other->id, 'quantity' => '3'],
        ];

        for ($attempt = 0; $attempt < 2; $attempt++) {
            $this->auth()->postJson('/api/cart/import', ['items' => $items])->assertOk()->assertJsonCount(2, 'data.items');
        }

        $this->assertDatabaseHas('cart_items', ['product_id' => $product->id, 'quantity' => 4]);
        $this->assertDatabaseHas('cart_items', ['product_id' => $other->id, 'quantity' => 3]);
        $this->assertDatabaseCount('cart_items', 2);
    }

    public function test_guest_cart_import_rolls_back_every_item_when_the_category_limit_is_exceeded(): void
    {
        $product = $this->createProduct();
        $other = $this->createProduct();
        $this->auth()->postJson('/api/cart/import', ['items' => [
            ['product_id' => $product->id, 'quantity' => 6],
            ['product_id' => $other->id, 'quantity' => 6],
        ]])->assertUnprocessable()->assertJsonValidationErrors('quantity');

        $this->assertDatabaseCount('cart_items', 0);
    }

    public function test_guest_cart_import_rejects_deleted_products_and_duplicate_ids(): void
    {
        $product = $this->createProduct();
        $deleted = $this->createProduct();
        $deleted->delete();
        $line = ['product_id' => $product->id, 'quantity' => 1];

        $this->auth()->postJson('/api/cart/import', ['items' => [
            $line,
            ['product_id' => $deleted->id, 'quantity' => 1],
        ]])->assertUnprocessable()->assertJsonValidationErrors('items.1.product_id');

        $this->auth()->postJson('/api/cart/import', ['items' => [
            $line,
            ['product_id' => (string) $product->id, 'quantity' => 2],
        ]])->assertUnprocessable()->assertJsonValidationErrors('items.1.product_id');

        $this->assertDatabaseCount('cart_items', 0);
    }

    public function test_guest_cart_import_rejects_a_changed_authenticated_account_before_mutation(): void
    {
        $product = $this->createProduct();
        $otherUser = User::factory()->create();

        $this->auth()->postJson('/api/cart/import', [
            'items' => [['product_id' => $product->id, 'quantity' => 1]],
        ], ['X-Pizza-Import-Account' => (string) $otherUser->id])->assertConflict();

        $this->assertDatabaseCount('cart_items', 0);
    }

    public function test_guest_cart_import_cannot_target_another_cart(): void
    {
        $product = $this->createProduct();
        $foreignCart = Cart::query()->create(['user_id' => User::factory()->create()->id]);

        $this->auth()->postJson('/api/cart/import', ['items' => [
            ['product_id' => $product->id, 'quantity' => 2, 'cart_id' => $foreignCart->id],
        ]])->assertUnprocessable()->assertJsonValidationErrors('items.0');

        $this->auth()->postJson('/api/cart/import', ['cart_id' => $foreignCart->id, 'items' => [
            ['product_id' => $product->id, 'quantity' => 2],
        ]])->assertOk()->assertJsonPath('data.items.0.quantity', 2);

        $this->assertDatabaseMissing('cart_items', ['cart_id' => $foreignCart->id]);
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
