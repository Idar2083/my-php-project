<?php

namespace Tests\Feature;

use App\Enums\UserRole;
use App\Http\Controllers\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

class ProductAuthorizationTest extends TestCase
{
    use RefreshDatabase;

    private function validProductData(): array
    {
        return [
            'name' => 'Pepperoni',
            'category' => 'Pizza',
            'description' => 'Description',
            'price' => 799,
            'weight' => 0.55,
        ];
    }

    private function createUser(): User
    {
        return User::factory()->create([
            'role' => UserRole::USER,
        ]);
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

    public function test_guest_cannot_create_product(): void
    {
        $response = $this->postJson(
            '/api/products',
            $this->validProductData()
        );

        $response->assertStatus(
            Response::HTTP_UNAUTHORIZED
        );
    }

    public function test_user_cannot_create_product(): void
    {
        $token = $this->tokenFor(
            $this->createUser()
        );

        $response = $this
            ->withHeaders([
                'Authorization' => "Bearer $token",
            ])
            ->postJson(
                '/api/products',
                $this->validProductData()
            );

        $response->assertStatus(
            Response::HTTP_FORBIDDEN
        );
    }

    public function test_admin_can_create_product(): void
    {
        $token = $this->tokenFor(
            $this->createAdmin()
        );

        $response = $this
            ->withHeaders([
                'Authorization' => "Bearer $token",
            ])
            ->postJson(
                '/api/products',
                $this->validProductData()
            );

        $response->assertStatus(
            Response::HTTP_CREATED
        );

        $this->assertDatabaseHas('products', [
            'name' => 'Pepperoni',
        ]);
    }
}
