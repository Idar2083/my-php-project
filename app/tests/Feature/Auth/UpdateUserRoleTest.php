<?php

declare(strict_types=1);

namespace Tests\Feature\Auth;

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class UpdateUserRoleTest extends TestCase
{
    use RefreshDatabase;

    public function test_guest_cannot_change_role(): void
    {
        $user = User::factory()->create();
        $this->patchJson($this->url($user), ['role' => 'admin'])->assertUnauthorized();
        $this->assertSame(UserRole::USER, $user->fresh()->role);
    }

    public function test_invalid_jwt_cannot_change_role(): void
    {
        $this->withToken('invalid')->patchJson('/api/admin/users/1/role', ['role' => 'admin'])
            ->assertUnauthorized();
    }

    public function test_ordinary_user_is_rejected_before_validation_and_target_lookup(): void
    {
        $user = User::factory()->create();
        $this->withToken(JWTAuth::fromUser($user));
        $this->patchJson($this->url($user), ['role' => 'admin'])->assertForbidden();
        $this->patchJson('/api/admin/users/999999/role', ['role' => 'invalid'])->assertForbidden();
        $this->assertSame(UserRole::USER, $user->fresh()->role);
    }

    public function test_admin_can_promote_and_only_role_changes(): void
    {
        $admin = User::factory()->admin()->create();
        $target = User::factory()->create();
        $before = $target->getAttributes();

        $response = $this->withToken(JWTAuth::fromUser($admin))
            ->patchJson($this->url($target), [
                'role' => 'admin',
                'name' => 'Unwanted rename',
                'password' => 'Unwanted password',
            ])->assertOk()->assertJsonPath('data.role', 'admin');

        $this->assertSame(['id', 'name', 'email', 'role', 'created_at'], array_keys($response->json('data')));
        $this->assertSame($target->id, $response->json('data.id'));
        $target->refresh();
        $this->assertSame(UserRole::ADMIN, $target->role);

        foreach (['name', 'email', 'password', 'remember_token', 'created_at'] as $field) {
            $this->assertSame($before[$field], $target->getRawOriginal($field));
        }

        $this->assertStringNotContainsString($before['password'], $response->getContent());
        $this->assertStringNotContainsString($before['remember_token'], $response->getContent());
    }

    public function test_admin_can_demote_another_admin(): void
    {
        $admin = User::factory()->admin()->create();
        $target = User::factory()->admin()->create();
        $this->withToken(JWTAuth::fromUser($admin))
            ->patchJson($this->url($target), ['role' => 'user'])
            ->assertOk()->assertJsonPath('data.role', 'user');
        $this->assertSame(UserRole::USER, $target->fresh()->role);
        $this->assertSame(UserRole::ADMIN, $admin->fresh()->role);
    }

    public function test_same_role_assignment_is_idempotent_including_self(): void
    {
        $admin = User::factory()->admin()->create();
        $user = User::factory()->create();
        $this->withToken(JWTAuth::fromUser($admin));

        foreach ([$admin, $user] as $target) {
            $target->refresh();
            $before = $target->getAttributes();
            $this->patchJson($this->url($target), ['role' => $target->role->value])->assertOk();
            $this->assertSame($before, $target->fresh()->getAttributes());
        }
    }

    public function test_unknown_numeric_and_non_numeric_users_return_404(): void
    {
        $this->withToken(JWTAuth::fromUser(User::factory()->admin()->create()));
        $this->patchJson('/api/admin/users/999999/role', ['role' => 'admin'])->assertNotFound();
        $this->patchJson('/api/admin/users/unknown/role', ['role' => 'admin'])->assertNotFound();
        $this->patchJson('/api/admin/users/999999999999999999999999/role', ['role' => 'admin'])
            ->assertNotFound();
        $this->patchJson('/api/admin/users/999999/role', ['role' => 'unknown'])
            ->assertUnprocessable()->assertJsonValidationErrors('role');
    }

    /** @param array<string, mixed> $payload */
    #[DataProvider('invalidRoles')]
    public function test_invalid_roles_return_422_without_mutation(array $payload): void
    {
        $admin = User::factory()->admin()->create();
        $target = User::factory()->create();
        $this->withToken(JWTAuth::fromUser($admin))
            ->patchJson($this->url($target), $payload)
            ->assertUnprocessable()->assertJsonValidationErrors('role');
        $this->assertSame(UserRole::USER, $target->fresh()->role);
    }

    /** @return array<string, array{array<string, mixed>}> */
    public static function invalidRoles(): array
    {
        return [
            'missing' => [[]],
            'null' => [['role' => null]],
            'array' => [['role' => ['admin']]],
            'number' => [['role' => 1]],
            'boolean' => [['role' => true]],
            'unknown' => [['role' => 'owner']],
            'case sensitive' => [['role' => 'ADMIN']],
        ];
    }

    #[DataProvider('conflictMessages')]
    public function test_self_and_last_admin_conflicts_are_localized(
        string $locale,
        string $lastAdminMessage,
        string $selfMessage,
    ): void {
        $admin = User::factory()->admin()->create();
        $this->withToken(JWTAuth::fromUser($admin))->withHeader('Accept-Language', $locale);

        $this->patchJson($this->url($admin), ['role' => 'user'])
            ->assertConflict()->assertExactJson(['message' => $lastAdminMessage]);
        $this->assertSame(UserRole::ADMIN, $admin->fresh()->role);

        User::factory()->admin()->create();
        $this->patchJson($this->url($admin), ['role' => 'user'])
            ->assertConflict()->assertExactJson(['message' => $selfMessage]);
        $this->assertSame(UserRole::ADMIN, $admin->fresh()->role);
    }

    /** @return array<string, array{string, string, string}> */
    public static function conflictMessages(): array
    {
        return [
            'english' => ['en', 'The last administrator cannot be demoted.', 'Administrators cannot demote themselves.'],
            'russian' => ['ru', 'Невозможно понизить роль последнего администратора.', 'Администратор не может понизить собственную роль.'],
            'fallback' => ['de', 'The last administrator cannot be demoted.', 'Administrators cannot demote themselves.'],
        ];
    }

    public function test_existing_jwt_reflects_role_changes_on_fresh_requests(): void
    {
        $admin = User::factory()->admin()->create();
        $target = User::factory()->create();
        $adminToken = JWTAuth::fromUser($admin);
        $targetToken = JWTAuth::fromUser($target);

        $this->app['auth']->forgetGuards();
        $this->app['tymon.jwt']->unsetToken();
        $this->withToken($targetToken)->getJson('/api/admin/users')->assertForbidden();
        $this->app['auth']->forgetGuards();
        $this->app['tymon.jwt']->unsetToken();
        $this->withToken($adminToken)->patchJson($this->url($target), ['role' => 'admin'])->assertOk();
        $this->app['auth']->forgetGuards();
        $this->app['tymon.jwt']->unsetToken();
        $this->withToken($targetToken)->getJson('/api/admin/users')->assertOk();
        $this->app['auth']->forgetGuards();
        $this->app['tymon.jwt']->unsetToken();
        $this->withToken($adminToken)->patchJson($this->url($target), ['role' => 'user'])->assertOk();
        $this->app['auth']->forgetGuards();
        $this->app['tymon.jwt']->unsetToken();
        $this->withToken($targetToken)->getJson('/api/admin/users')->assertForbidden();
        $this->app['auth']->forgetGuards();
        $this->app['tymon.jwt']->unsetToken();
        $this->withToken($targetToken)->getJson('/api/me')
            ->assertOk()->assertJsonPath('id', $target->id)->assertJsonPath('role', 'user');
    }

    private function url(User $user): string
    {
        return '/api/admin/users/' . $user->id . '/role';
    }
}
