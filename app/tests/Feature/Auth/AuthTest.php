<?php

declare(strict_types=1);

namespace Tests\Feature\Auth;

use App\Modules\Auth\Domain\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class AuthTest extends TestCase
{
    use RefreshDatabase;

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

    public function test_unauthenticated_response_uses_russian_locale(): void
    {
        $response = $this
            ->withHeader('Accept-Language', 'ru')
            ->getJson('/api/orders');

        $response
            ->assertStatus(Response::HTTP_UNAUTHORIZED)
            ->assertExactJson([
                'message' => 'Необходима аутентификация.',
            ]);
    }

    public function test_unauthenticated_response_uses_english_locale(): void
    {
        $response = $this
            ->withHeader('Accept-Language', 'en')
            ->getJson('/api/orders');

        $response
            ->assertStatus(Response::HTTP_UNAUTHORIZED)
            ->assertExactJson([
                'message' => 'Unauthenticated.',
            ]);
    }

    public function test_unauthenticated_response_unknown_locale_falls_back_to_english(): void
    {
        $response = $this
            ->withHeader('Accept-Language', 'de')
            ->getJson('/api/orders');

        $response
            ->assertStatus(Response::HTTP_UNAUTHORIZED)
            ->assertExactJson([
                'message' => 'Unauthenticated.',
            ]);
    }

    public function test_registration_validation_uses_russian_locale(): void
    {
        $response = $this
            ->withHeader('Accept-Language', 'ru')
            ->postJson('/api/register', [
                'name' => '',
                'email' => 'invalid',
                'password' => 'short',
            ]);

        $response
            ->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
            ->assertJsonPath(
                'errors.name.0',
                'Поле «имя» обязательно для заполнения.',
            )
            ->assertJsonPath(
                'errors.email.0',
                'Поле «электронная почта» должно содержать корректный адрес электронной почты.',
            )
            ->assertJsonPath(
                'errors.password.0',
                'Поле «пароль» должно содержать не менее 8 символов.',
            );
    }

    public function test_registration_validation_uses_english_locale(): void
    {
        $response = $this
            ->withHeader('Accept-Language', 'en')
            ->postJson('/api/register', [
                'name' => '',
                'email' => 'invalid',
                'password' => 'short',
            ]);

        $response
            ->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
            ->assertJsonPath(
                'errors.name.0',
                'The name field is required.',
            )
            ->assertJsonPath(
                'errors.email.0',
                'The email field must be a valid email address.',
            )
            ->assertJsonPath(
                'errors.password.0',
                'The password field must be at least 8 characters.',
            );
    }

    public function test_registration_validation_unknown_locale_falls_back_to_english(): void
    {
        $response = $this
            ->withHeader('Accept-Language', 'de')
            ->postJson('/api/register', [
                'name' => '',
                'email' => 'invalid',
                'password' => 'short',
            ]);

        $response
            ->assertStatus(Response::HTTP_UNPROCESSABLE_ENTITY)
            ->assertJsonPath(
                'errors.name.0',
                'The name field is required.',
            )
            ->assertJsonPath(
                'errors.email.0',
                'The email field must be a valid email address.',
            )
            ->assertJsonPath(
                'errors.password.0',
                'The password field must be at least 8 characters.',
            );
    }

    /**
     * @return array{
     *     name: string,
     *     email: string,
     *     password: string
     * }
     */
    private function registerData(): array
    {
        return [
            'name' => 'John Doe',
            'email' => 'john@example.com',
            'password' => 'Password1!',
        ];
    }

    /**
     * @param array<string, mixed> $attributes
     */
    private function createUser(array $attributes = []): User
    {
        return User::factory()->create(
            array_merge([
                'email' => 'john@example.com',
                'password' => 'Password1!',
            ], $attributes),
        );
    }

    /**
     * @return array{
     *     email: string,
     *     password: string
     * }
     */
    private function loginCredentials(): array
    {
        return [
            'email' => 'john@example.com',
            'password' => 'Password1!',
        ];
    }
}
