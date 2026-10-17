<?php

declare(strict_types=1);

namespace Tests\Feature\Auth;

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Hash;
use Tests\TestCase;

final class CreateAdminCommandTest extends TestCase
{
    use RefreshDatabase;

    public function test_noninteractive_execution_cannot_create_an_admin(): void
    {
        $this->artisan('auth:create-admin', ['--no-interaction' => true])->assertFailed();
        $this->assertDatabaseCount('users', 0);
    }

    public function test_creates_admin_with_hashed_secret(): void
    {
        $this->artisan('auth:create-admin')
            ->expectsQuestion('Name', 'Owner')
            ->expectsQuestion('Email', 'owner@example.com')
            ->expectsQuestion('Password', 'LongSecurePassword!123')
            ->expectsQuestion('Confirm password', 'LongSecurePassword!123')
            ->assertSuccessful();
        $user = User::query()->where('email', 'owner@example.com')->firstOrFail();
        self::assertSame(UserRole::ADMIN, $user->role);
        self::assertTrue(Hash::check('LongSecurePassword!123', $user->password));
    }

    public function test_duplicate_email_does_not_promote_existing_customer(): void
    {
        $user = User::factory()->create(['email' => 'owner@example.com']);
        $this->artisan('auth:create-admin')
            ->expectsQuestion('Name', 'Owner')
            ->expectsQuestion('Email', 'owner@example.com')
            ->expectsQuestion('Password', 'LongSecurePassword!123')
            ->expectsQuestion('Confirm password', 'LongSecurePassword!123')
            ->assertFailed();
        self::assertSame(UserRole::USER, $user->refresh()->role);
        $this->assertDatabaseCount('users', 1);
    }

    public function test_mismatched_passwords_do_not_create_an_admin(): void
    {
        $this->artisan('auth:create-admin')
            ->expectsQuestion('Name', 'Owner')
            ->expectsQuestion('Email', 'owner@example.com')
            ->expectsQuestion('Password', 'LongSecurePassword!123')
            ->expectsQuestion('Confirm password', 'different')
            ->assertFailed();
        $this->assertDatabaseCount('users', 0);
    }
}
