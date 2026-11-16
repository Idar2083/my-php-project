<?php

declare(strict_types=1);

namespace Tests\Feature\Catalog;

use App\Modules\Catalog\Application\Services\ProductService;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

class ProductCacheTest extends TestCase
{
    use RefreshDatabase;

    public function test_product_cache_version_is_incremented(): void
    {
        Cache::flush();

        $service = app(ProductService::class);

        $this->assertNull(
            Cache::get('products.version'),
        );

        $service->bumpCacheVersion();

        $this->assertSame(
            2,
            (int) Cache::get('products.version'),
        );

        $service->bumpCacheVersion();

        $this->assertSame(
            3,
            (int) Cache::get('products.version'),
        );
    }

    public function test_first_product_invalidates_a_cached_empty_catalog(): void
    {
        Cache::flush();
        $this->getJson('/api/products')->assertOk()->assertJsonCount(0, 'data');
        $product = Product::factory()->create();
        $this->getJson('/api/products')->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.id', $product->id);
    }

    public function test_products_are_cached(): void
    {
        Cache::flush();

        $this->assertFalse(
            Cache::has('products.attributes.v1.page.1'),
        );

        $this->getJson('/api/products')
            ->assertStatus(Response::HTTP_OK);

        $this->assertTrue(
            Cache::has('products.attributes.v1.page.1'),
        );
    }

    public function test_database_cache_preserves_products_without_unserializing_models(): void
    {
        config([
            'cache.default' => 'database',
            'cache.serializable_classes' => false,
        ]);
        Cache::purge('database');
        Cache::flush();

        $product = Product::factory()->create([
            'name' => 'Cached pizza',
            'price' => 12.50,
            'weight' => '0.500',
        ]);
        $version = (int) Cache::get('products.version', 1);
        $legacyKey = sprintf('products.v%d.page.1', $version);
        Cache::put($legacyKey, [
            'items' => [$product],
            'total' => 1,
            'current_page' => 1,
            'per_page' => 30,
        ], 60);

        $first = $this->getJson('/api/products?page=1')
            ->assertStatus(Response::HTTP_OK)
            ->assertJsonPath('data.0.name', 'Cached pizza')
            ->assertJsonPath('data.0.price', 12.5)
            ->assertJsonPath('data.0.weight', '0.500');

        // Bypass the observer so the second request must use the previously cached product.
        Product::query()->whereKey($product->id)->update([
            'name' => 'Changed only in the database',
        ]);

        $second = $this->getJson('/api/products?page=1')
            ->assertStatus(Response::HTTP_OK)
            ->assertJsonPath('data.0.name', 'Cached pizza');

        $this->assertSame($first->json(), $second->json());
        $this->assertTrue(Cache::has($legacyKey));
    }
}
