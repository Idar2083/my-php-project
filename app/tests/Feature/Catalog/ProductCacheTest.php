<?php

declare(strict_types=1);

namespace Tests\Feature\Catalog;

use App\Modules\Catalog\Application\Services\ProductService;
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
            1,
            (int) Cache::get('products.version'),
        );

        $service->bumpCacheVersion();

        $this->assertSame(
            2,
            (int) Cache::get('products.version'),
        );
    }

    public function test_products_are_cached(): void
    {
        Cache::flush();

        $this->assertFalse(
            Cache::has('products.v1.page.1'),
        );

        $this->getJson('/api/products')
            ->assertStatus(Response::HTTP_OK);

        $this->assertTrue(
            Cache::has('products.v1.page.1'),
        );
    }
}
