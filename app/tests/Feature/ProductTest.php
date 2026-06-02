<?php

namespace Tests\Feature;

use Illuminate\Foundation\Testing\RefreshDatabase;
use App\Http\Controllers\Models\Product;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;

class ProductTest extends TestCase
{
    use RefreshDatabase;

    private function validProductData(): array
    {
        return [
            'name' => 'Pepperoni',
            'category' => 'Pizza',
            'description' => '...',
            'price' => 799,
            'weight' => 0.55,
        ];
    }

    private function createProduct(): Product
    {
        return Product::create($this->validProductData());
    }

    //create
    public function test_can_create_product(): void
    {
        $response = $this->postJson(
            '/api/products',
            $this->validProductData()
        );

        $response->assertStatus(Response::HTTP_CREATED);

        $this->assertDatabaseHas('products',
            [
                'name' => 'Pepperoni',
                'category' => 'Pizza',
            ]
        );
    }

    public function test_cannot_create_product_with_invalid_data(): void
    {
        $response = $this->postJson('/api/products',
            [
                'name' => '',
                'category' => '',
                'price' => -1,
                'weight' => -1,
            ]
        );

        $response->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
            ->assertJsonValidationErrors([
                'name',
                'category',
                'price',
                'weight',
            ]);
    }

    //read all
    public function test_can_get_products(): void
    {
        $this->createProduct();

        $response = $this->getJson('/api/products');

        $response->assertStatus(Response::HTTP_OK)
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
                    ]
                ]
            ]);
    }

    public function test_returns_empty_products_list(): void
    {
        $response = $this->getJson('/api/products');

        $response->assertStatus(Response::HTTP_OK)
            ->assertJson([
                'data' => []
            ]);
    }

    //read one
    public function test_can_get_product_by_id(): void
    {
        $product = $this->createProduct();

        $response = $this->getJson("/api/products/{$product->id}");

        $response->assertStatus(Response::HTTP_OK)
            ->assertJsonFragment([
                'id' => $product->id,
                'name' => $product->name,
            ]);
    }

    public function test_returns_404_for_missing_product(): void
    {
        $missingProductId = 999;

        $response = $this->getJson("/api/products/{$missingProductId}");

        $response->assertStatus(Response::HTTP_NOT_FOUND);
    }

    //update
    public function test_can_update_product(): void
    {
        $product = $this->createProduct();

        $response = $this->putJson("/api/products/{$product->id}",
            [
                ...$this->validProductData(),
                'name' => 'Four Cheese',
                'price' => 899,
            ]
        );

        $response->assertStatus(Response::HTTP_OK);

        $this->assertDatabaseHas('products',
            [
                'id' => $product->id,
                'name' => 'Four Cheese',
            ]
        );
    }

    public function test_cannot_update_product_with_invalid_data(): void
    {
        $product = $this->createProduct();

        $response = $this->putJson(
            "/api/products/{$product->id}",
            [
                'price' => -100,
            ]
        );

        $response->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY);
    }

    //delete
    public function test_can_delete_product(): void
    {
        $product = $this->createProduct();

        $response = $this->deleteJson("/api/products/{$product->id}");

        $response->assertStatus(Response::HTTP_NO_CONTENT);

        $this->assertDatabaseMissing('products',
            [
                'id' => $product->id,
            ]
        );
    }

    public function test_returns_404_when_deleting_missing_product(): void
    {
        $missingProductId = 999;

        $response = $this->deleteJson("/api/products/{$missingProductId}");

        $response->assertStatus(Response::HTTP_NOT_FOUND);
    }
}

