<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Http\Controllers\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

class AuthTest extends TestCase
{
    use RefreshDatabase;

    private function registerData(): array
    {
        return [
            'name' => 'John Doe',
            'email' => 'john@example.com',
            'password' => 'Password1!',
        ];
    }

    private function createUser(array $attributes = []): User
    {
        return User::factory()->create(
            array_merge([
                'email' => 'john@example.com',
                'password' => 'Password1!',
            ], $attributes),
        );
    }

    private function loginCredentials(): array
    {
        return [
            'email' => 'john@example.com',
            'password' => 'Password1!',
        ];
    }

    public function test_user_can_register(): void
    {
        $response = $this->postJson(
            '/api/register',
            $this->registerData(),
        );

        $response
            ->assertStatus(Response::HTTP_OK)
            ->assertJsonStructure([
                'token',
                'token_type',
            ]);

        $this->assertDatabaseHas('users', [
            'email' => 'john@example.com',
        ]);
    }

    public function test_user_can_login(): void
    {
        $this->createUser();

        $response = $this->postJson(
            '/api/login',
            $this->loginCredentials(),
        );

        $response
            ->assertStatus(Response::HTTP_OK)
            ->assertJsonStructure([
                'token',
                'token_type',
            ]);
    }

    public function test_user_can_logout(): void
    {
        $user = $this->createUser();

        $token = JWTAuth::fromUser($user);

        $response = $this
            ->withHeaders([
                'Authorization' => "Bearer $token",
            ])
            ->postJson('/api/logout');

        $response->assertStatus(Response::HTTP_OK);
    }
}
