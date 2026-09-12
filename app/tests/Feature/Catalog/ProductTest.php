<?php

declare(strict_types=1);

namespace Tests\Feature\Catalog;

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class ProductTest extends TestCase
{
    use RefreshDatabase;

    public function test_can_create_product(): void
    {
        $response = $this
            ->withHeaders($this->authHeaders())
            ->postJson(
                '/api/products',
                $this->validProductData(),
            );

        $response->assertStatus(Response::HTTP_CREATED);

        $this->assertDatabaseHas('products', [
            'name' => 'Pepperoni',
            'category' => 'Pizza',
        ]);
    }

    public function test_cannot_create_product_with_invalid_data(): void
    {
        $response = $this
            ->withHeaders($this->authHeaders())
            ->postJson(
                '/api/products',
                [
                    'name' => '',
                    'category' => '',
                    'price' => -1,
                    'weight' => -1,
                ],
            );

        $response
            ->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
            ->assertJsonValidationErrors([
                'name',
                'category',
                'price',
                'weight',
            ]);
    }

    public function test_can_update_product(): void
    {
        $product = $this->createProduct();

        $response = $this
            ->withHeaders($this->authHeaders())
            ->putJson(
                '/api/products/' . $product->id,
                [
                    ...$this->validProductData(),
                    'name' => 'Four Cheese',
                    'price' => 899,
                ],
            );

        $response->assertStatus(Response::HTTP_OK);

        $this->assertDatabaseHas('products', [
            'id' => $product->id,
            'name' => 'Four Cheese',
        ]);
    }

    public function test_cannot_update_product_with_invalid_data(): void
    {
        $product = $this->createProduct();

        $response = $this
            ->withHeaders($this->authHeaders())
            ->putJson(
                '/api/products/' . $product->id,
                [
                    'price' => -100,
                ],
            );

        $response->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY);
    }

    public function test_can_delete_product(): void
    {
        $product = $this->createProduct();

        $response = $this
            ->withHeaders($this->authHeaders())
            ->deleteJson(
                '/api/products/' . $product->id,
            );

        $response->assertStatus(Response::HTTP_NO_CONTENT);

        $this->assertDatabaseMissing('products', [
            'id' => $product->id,
        ]);
    }

    public function test_returns_404_when_deleting_missing_product(): void
    {
        $response = $this
            ->withHeaders($this->authHeaders())
            ->deleteJson('/api/products/999');

        $response->assertStatus(Response::HTTP_NOT_FOUND);
    }

    /**
     * @return array{
     *     name: string,
     *     category: string,
     *     description: string,
     *     price: int,
     *     weight: float
     * }
     */
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
        return Product::factory()->create(
            $this->validProductData(),
        );
    }

    private function createAdmin(): User
    {
        return User::factory()->create([
            'role' => UserRole::ADMIN,
        ]);
    }

    private function tokenFor(User $user): string
    {
        return JWTAuth::fromUser($user);
    }

    /**
     * @return array{Authorization: string}
     */
    private function authHeaders(): array
    {
        return [
            'Authorization' => 'Bearer ' . $this->tokenFor(
                $this->createAdmin(),
            ),
        ];
    }
}
