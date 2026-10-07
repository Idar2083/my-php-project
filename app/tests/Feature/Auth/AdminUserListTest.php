<?php

declare(strict_types=1);

namespace Tests\Feature\Auth;

use App\Modules\Auth\Domain\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class AdminUserListTest extends TestCase
{
    use RefreshDatabase;

    public function test_guest_cannot_list_users(): void
    {
        $this->getJson('/api/admin/users')->assertUnauthorized();
    }

    public function test_invalid_jwt_cannot_list_users(): void
    {
        $this->withToken('invalid')->getJson('/api/admin/users')->assertUnauthorized();
    }

    public function test_ordinary_user_is_rejected_before_pagination_validation(): void
    {
        $this->withToken(JWTAuth::fromUser(User::factory()->create()))
            ->getJson('/api/admin/users?per_page=0')->assertForbidden();
    }

    public function test_admin_gets_default_page_with_only_safe_fields(): void
    {
        $admin = User::factory()->admin()->create();
        User::factory()->count(24)->create();

        $response = $this->withToken(JWTAuth::fromUser($admin))
            ->getJson('/api/admin/users')
            ->assertOk()
            ->assertJsonCount(20, 'data')
            ->assertJsonPath('meta.total', 25)
            ->assertJsonPath('meta.per_page', 20)
            ->assertJsonStructure(['data', 'links', 'meta']);

        $this->assertSame(
            User::query()->orderBy('id')->limit(20)->pluck('id')->all(),
            array_column($response->json('data'), 'id'),
        );

        foreach ($response->json('data') as $user) {
            $this->assertSame(['id', 'name', 'email', 'role', 'created_at'], array_keys($user));
            $this->assertContains($user['role'], ['admin', 'user']);
            $this->assertNotNull($user['created_at']);
        }

        $this->assertSame($admin->email, $response->json('data.0.email'));
        $this->assertStringNotContainsString($admin->password, $response->getContent());
        $this->assertStringNotContainsString($admin->remember_token, $response->getContent());
    }

    public function test_pages_have_stable_non_overlapping_ids(): void
    {
        $admin = User::factory()->admin()->create();
        User::factory()->count(4)->create();
        $this->withToken(JWTAuth::fromUser($admin));

        $first = $this->getJson('/api/admin/users?per_page=2&page=1')
            ->assertOk()->assertJsonCount(2, 'data')->assertJsonPath('meta.total', 5);
        $second = $this->getJson('/api/admin/users?per_page=2&page=2')
            ->assertOk()->assertJsonCount(2, 'data')->assertJsonPath('meta.current_page', 2);

        $this->assertSame(
            User::query()->orderBy('id')->limit(4)->pluck('id')->all(),
            array_merge(array_column($first->json('data'), 'id'), array_column($second->json('data'), 'id')),
        );
    }

    public function test_maximum_page_size_and_empty_page(): void
    {
        $admin = User::factory()->admin()->create();
        User::factory()->count(100)->create();
        $this->withToken(JWTAuth::fromUser($admin));

        $this->getJson('/api/admin/users?per_page=100')
            ->assertOk()->assertJsonCount(100, 'data')->assertJsonPath('meta.per_page', 100);
        $this->getJson('/api/admin/users?per_page=100&page=3')
            ->assertOk()->assertJsonPath('data', [])
            ->assertJsonPath('meta.current_page', 3)->assertJsonPath('meta.total', 101)
            ->assertJsonPath('meta.last_page', 2);
    }

    public function test_very_large_page_returns_empty_data_instead_of_first_page(): void
    {
        $admin = User::factory()->admin()->create();
        User::factory()->count(24)->create();
        $this->withToken(JWTAuth::fromUser($admin));

        $this->getJson('/api/admin/users')
            ->assertOk()->assertJsonCount(20, 'data')->assertJsonPath('data.0.id', $admin->id);

        $this->getJson('/api/admin/users?page=' . PHP_INT_MAX)
            ->assertOk()->assertJsonPath('data', [])
            ->assertJsonPath('meta.current_page', PHP_INT_MAX)
            ->assertJsonPath('meta.per_page', 20)->assertJsonPath('meta.total', 25)
            ->assertJsonPath('meta.last_page', 2)
            ->assertJsonPath('meta.from', null)->assertJsonPath('meta.to', null);
    }

    #[DataProvider('invalidPagination')]
    public function test_invalid_pagination_returns_422(string $query, string $field): void
    {
        $this->withToken(JWTAuth::fromUser(User::factory()->admin()->create()))
            ->getJson('/api/admin/users?' . $query)
            ->assertUnprocessable()->assertJsonValidationErrors($field);
    }

    /** @return array<string, array{string, string}> */
    public static function invalidPagination(): array
    {
        return [
            'page zero' => ['page=0', 'page'],
            'negative page' => ['page=-1', 'page'],
            'fractional page' => ['page=1.5', 'page'],
            'array page' => ['page[]=1', 'page'],
            'page size zero' => ['per_page=0', 'per_page'],
            'negative size' => ['per_page=-1', 'per_page'],
            'over limit' => ['per_page=101', 'per_page'],
            'fractional size' => ['per_page=2.5', 'per_page'],
            'text size' => ['per_page=all', 'per_page'],
            'array size' => ['per_page[]=2', 'per_page'],
        ];
    }
}
