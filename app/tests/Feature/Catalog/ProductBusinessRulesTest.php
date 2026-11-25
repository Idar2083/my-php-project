<?php

declare(strict_types=1);

namespace Tests\Feature\Catalog;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class ProductBusinessRulesTest extends TestCase
{
    use RefreshDatabase;

    /** @return iterable<string, array{int|float|string, int}> */
    public static function prices(): iterable
    {
        yield 'zero' => [0, 0];
        yield 'smallest positive' => [0.01, 1];
        yield '29 cents' => [0.29, 29];
        yield '115 cents' => [1.15, 115];
        yield '1999 cents' => [19.99, 1_999];
        yield 'maximum numeric' => [21_474_836.47, 2_147_483_647];
        yield 'maximum string' => ['21474836.47', 2_147_483_647];
    }

    /** @return iterable<array{int|float|string}> */
    public static function invalidPrices(): iterable
    {
        foreach ([-0.01, 0.001, '1.150', '21474836.48', 21_474_837, '1e2'] as $price) {
            yield [$price];
        }
    }

    /** @return iterable<array{string}> */
    public static function categories(): iterable
    {
        foreach (['pizza', 'Pizza', 'PIZZA', 'pIzZa', 'drink', 'Drink', 'DRINK'] as $category) {
            yield [$category];
        }
    }

    #[DataProvider('prices')]
    public function test_prices_are_stored_as_exact_cents(int|float|string $price, int $cents): void
    {
        $id = $this->postJson('/api/products', ['price' => $price] + $this->productData())
            ->assertCreated()->json('data.id');
        $this->assertDatabaseHas('products', ['id' => $id, 'price' => $cents]);
        $this->assertEquals((float) $price, $this->getJson('/api/products/' . $id)->assertOk()->json('data.price'));
        $this->putJson('/api/products/' . $id, ['price' => $price])->assertOk();
        $this->assertDatabaseHas('products', ['id' => $id, 'price' => $cents]);
    }

    #[DataProvider('invalidPrices')]
    public function test_price_precision_and_range_are_validated(int|float|string $price): void
    {
        $this->postJson('/api/products', ['price' => $price] + $this->productData())
            ->assertUnprocessable()->assertJsonValidationErrors('price');
        $product = Product::factory()->create();
        $this->putJson('/api/products/' . $product->id, ['price' => $price])
            ->assertUnprocessable()->assertJsonValidationErrors('price');
        $this->assertDatabaseHas('products', ['id' => $product->id, 'price' => 50_000]);
    }

    #[DataProvider('categories')]
    public function test_catalog_categories_can_be_added_to_cart_without_rewriting_labels(string $category): void
    {
        $id = $this->postJson('/api/products', ['category' => $category, 'price' => 19.99] + $this->productData())
            ->assertCreated()->assertJsonPath('data.category', $category)->json('data.id');
        $this->getJson('/api/products')->assertOk()->assertJsonPath('data.0.category', $category);
        $this->postJson('/api/cart/items', ['product_id' => $id, 'quantity' => 1])->assertOk();
        $this->assertDatabaseHas('products', ['id' => $id, 'category' => $category]);
    }

    public function test_unsupported_categories_are_rejected_without_rewriting_legacy_data(): void
    {
        $this->postJson('/api/products', ['category' => 'other', 'price' => 1] + $this->productData())
            ->assertUnprocessable()->assertJsonValidationErrors('category');
        $product = Product::factory()->create(['category' => 'legacy']);
        $this->putJson('/api/products/' . $product->id, ['category' => 'other'])
            ->assertUnprocessable()->assertJsonValidationErrors('category');
        $this->postJson('/api/cart/items', ['product_id' => $product->id, 'quantity' => 1])->assertUnprocessable();
        $this->assertDatabaseHas('products', ['id' => $product->id, 'category' => 'legacy']);
    }

    public function test_category_limits_include_legacy_case_variants(): void
    {
        $first = Product::factory()->create(['category' => 'Pizza']);
        $second = Product::factory()->create(['category' => 'pizza']);
        $this->postJson('/api/cart/items', ['product_id' => $first->id, 'quantity' => 9])->assertOk();
        $this->postJson('/api/cart/items', ['product_id' => $second->id, 'quantity' => 2])->assertUnprocessable();
        $this->postJson('/api/cart/items', ['product_id' => $second->id, 'quantity' => 1])->assertOk();
    }

    protected function setUp(): void
    {
        parent::setUp();
        Cache::flush();
        $this->withHeader('Authorization', 'Bearer ' . JWTAuth::fromUser(User::factory()->admin()->create()));
    }

    /** @return array<string, string|float> */
    private function productData(): array
    {
        return ['name' => 'Exact price pizza', 'category' => 'pizza', 'weight' => 0.5];
    }
}
