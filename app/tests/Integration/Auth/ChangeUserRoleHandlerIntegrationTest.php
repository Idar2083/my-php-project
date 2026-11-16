<?php

declare(strict_types=1);

namespace Tests\Integration\Auth;

use App\Modules\Auth\Application\Handlers\ChangeUserRoleHandler;
use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use App\Shared\Application\Exceptions\TranslatableException;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Tests\TestCase;

final class ChangeUserRoleHandlerIntegrationTest extends TestCase
{
    use RefreshDatabase;

    public function test_database_is_postgresql_read_committed(): void
    {
        $this->assertSame('pgsql', DB::connection()->getDriverName());
        $this->assertSame('read committed', DB::selectOne('SHOW transaction_isolation')->transaction_isolation);
    }

    public function test_stale_admin_is_reauthorized_from_database(): void
    {
        $actor = User::factory()->admin()->create();
        $target = User::factory()->create();
        User::query()->whereKey($actor->id)->update(['role' => UserRole::USER]);
        $this->assertSame(UserRole::ADMIN, $actor->role);

        $this->expectException(AuthorizationException::class);

        try {
            app(ChangeUserRoleHandler::class)->handle($actor->id, $target->id, UserRole::ADMIN);
        } finally {
            $this->assertSame(UserRole::USER, $target->fresh()->role);
        }
    }

    public function test_missing_actor_is_forbidden_even_with_missing_target(): void
    {
        $this->expectException(AuthorizationException::class);
        app(ChangeUserRoleHandler::class)->handle(999_998, 999_999, UserRole::ADMIN);
    }

    public function test_missing_target_is_not_found_for_current_admin(): void
    {
        $actor = User::factory()->admin()->create();
        $this->expectException(ModelNotFoundException::class);
        app(ChangeUserRoleHandler::class)->handle($actor->id, 999_999, UserRole::ADMIN);
    }

    public function test_conflict_rolls_back_and_next_change_succeeds(): void
    {
        $actor = User::factory()->admin()->create();
        $target = User::factory()->create();
        $handler = app(ChangeUserRoleHandler::class);
        $level = DB::transactionLevel();

        try {
            $handler->handle($actor->id, $actor->id, UserRole::USER);
            $this->fail('Last administrator demotion must be rejected.');
        } catch (TranslatableException $exception) {
            $this->assertSame('api.auth.last_admin', $exception->translationKey());
            $this->assertSame(409, $exception->statusCode());
        }

        $this->assertSame($level, DB::transactionLevel());
        $this->assertSame(UserRole::ADMIN, $actor->fresh()->role);
        $this->assertSame(UserRole::ADMIN, $handler->handle($actor->id, $target->id, UserRole::ADMIN)->role);
    }

    public function test_self_demotion_with_other_admin_is_rejected(): void
    {
        $actor = User::factory()->admin()->create();
        User::factory()->admin()->create();

        try {
            app(ChangeUserRoleHandler::class)->handle($actor->id, $actor->id, UserRole::USER);
            $this->fail('Self-demotion must be rejected.');
        } catch (TranslatableException $exception) {
            $this->assertSame('api.auth.self_demotion', $exception->translationKey());
        }

        $this->assertSame(UserRole::ADMIN, $actor->fresh()->role);
    }
}
