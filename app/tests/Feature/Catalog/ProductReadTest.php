<?php

declare(strict_types=1);

namespace Tests\Feature\Catalog;

use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

final class ProductReadTest extends TestCase
{
    use RefreshDatabase;

    public function test_can_get_products(): void
    {
        $this->createProduct();

        $response = $this->getJson('/api/products');

        $response
            ->assertStatus(Response::HTTP_OK)
            ->assertJsonFragment([
                'name' => 'Pepperoni',
                'category' => 'Pizza',
            ])
            ->assertJsonStructure([
                'data' => [
                    '*' => [
                        'id',
                        'name',
                        'category',
                        'description',
                        'price',
                        'weight',
                    ],
                ],
            ]);
    }

    public function test_returns_empty_products_list(): void
    {
        $this->getJson('/api/products')
            ->assertStatus(Response::HTTP_OK)
            ->assertJson([
                'data' => [],
            ]);
    }

    public function test_can_get_product_by_id(): void
    {
        $product = $this->createProduct();

        $this->getJson('/api/products/' . $product->id)
            ->assertStatus(Response::HTTP_OK)
            ->assertJsonFragment([
                'id' => $product->id,
                'name' => $product->name,
            ]);
    }

    public function test_returns_404_for_missing_product(): void
    {
        $this->getJson('/api/products/999')
            ->assertStatus(Response::HTTP_NOT_FOUND);
    }

    protected function setUp(): void
    {
        parent::setUp();

        Cache::flush();
    }

    private function createProduct(): Product
    {
        return Product::factory()->create([
            'name' => 'Pepperoni',
            'category' => 'Pizza',
            'description' => '...',
            'price' => 799,
            'weight' => 0.55,
        ]);
    }
}
