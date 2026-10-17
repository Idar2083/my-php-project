<?php

declare(strict_types=1);

namespace Tests\Feature\Auth;

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use App\Modules\Report\Domain\Models\Report;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;

final class ApiSecurityTest extends TestCase
{
    use RefreshDatabase;

    public function test_login_limit_ignores_spoofed_forwarding_headers_and_expires(): void
    {
        for ($i = 0; $i < 5; ++$i) {
            $this->withHeader('X-Forwarded-For', '192.0.2.' . $i)
                ->postJson('/api/login', ['email' => 'absent@example.com', 'password' => 'invalid'])
                ->assertUnauthorized()->assertJsonStructure(['message']);
        }
        $this->postJson('/api/login', ['email' => 'absent@example.com', 'password' => 'invalid'])
            ->assertTooManyRequests()->assertHeader('Retry-After');
        $this->travel(61)->seconds();
        $this->postJson('/api/login', ['email' => 'absent@example.com', 'password' => 'invalid'])->assertUnauthorized();
    }

    public function test_ip_limit_also_blocks_rotating_email_addresses(): void
    {
        for ($i = 0; $i < 30; ++$i) {
            $this->postJson('/api/login', ['email' => 'absent' . $i . '@example.com', 'password' => 'invalid'])
                ->assertUnauthorized();
        }
        $this->postJson('/api/login', ['email' => 'another@example.com', 'password' => 'invalid'])
            ->assertTooManyRequests();
    }

    public function test_normal_repeated_logins_still_issue_working_jwt_tokens(): void
    {
        $user = User::factory()->create(['password' => 'SecurePassword!123']);
        for ($i = 0; $i < 3; ++$i) {
            $response = $this->postJson('/api/login', ['email' => $user->email, 'password' => 'SecurePassword!123'])
                ->assertOk()->assertJsonPath('token_type', 'bearer');
            $this->withToken($response->json('token'))->getJson('/api/me')
                ->assertOk()->assertJsonPath('id', $user->id)->assertJsonMissingPath('password');
        }
    }

    public function test_registration_limit_includes_invalid_requests(): void
    {
        for ($i = 0; $i < 5; ++$i) {
            $this->postJson('/api/register', [])->assertUnprocessable()->assertJsonValidationErrors(['email']);
        }
        $this->postJson('/api/register', [])->assertTooManyRequests();
        $this->travel(61)->seconds();
        $this->postJson('/api/register', [])->assertUnprocessable();
    }

    public function test_registration_cannot_assign_privileged_attributes(): void
    {
        $this->postJson('/api/register', [
            'name' => 'Buyer', 'email' => 'buyer@example.com', 'password' => 'SafePassword!123',
            'role' => 'admin', 'id' => 1_234, 'email_verified_at' => now()->toISOString(),
        ])->assertOk()->assertJsonStructure(['token', 'token_type'])->assertJsonMissingPath('password');
        $user = User::query()->where('email', 'buyer@example.com')->firstOrFail();
        self::assertSame(UserRole::USER, $user->role);
        self::assertNull($user->email_verified_at);
        self::assertNotSame(1_234, $user->id);
        $user->fill(['role' => 'admin']);
        self::assertSame(UserRole::USER, $user->role);
    }

    public function test_customer_is_denied_every_admin_action(): void
    {
        Report::factory()->create(['id' => 1]);
        $this->actingAs(User::factory()->create(), 'api');
        foreach ([['get', '/admin/users'], ['patch', '/admin/users/1/role'], ['post', '/products'],
            ['put', '/products/1'], ['delete', '/products/1'], ['post', '/reports'],
            ['get', '/reports/1'], ['get', '/reports/1/download'], ['put', '/orders/1/status']] as [$method, $path]) {
            $this->json($method, '/api' . $path, ['role' => 'admin', 'status' => 'paid'])->assertForbidden();
        }
    }

    public function test_product_weight_limits_match_postgres(): void
    {
        $this->actingAs(User::factory()->admin()->create(), 'api');
        foreach ([-1, 0, 0.000_1, 100, '1e40', 'invalid', null] as $weight) {
            $this->postJson('/api/products', ['name' => 'Pizza', 'price' => 10, 'category' => 'pizza', 'weight' => $weight])
                ->assertUnprocessable()->assertJsonValidationErrors('weight');
        }
        foreach (['0.001', '99.999'] as $weight) {
            $this->postJson('/api/products', ['name' => 'Pizza', 'price' => 10, 'category' => 'pizza', 'weight' => $weight])
                ->assertCreated()->assertJsonPath('data.weight', $weight);
        }
    }

    public function test_invalid_pagination_identifiers_quantity_and_delivery(): void
    {
        foreach (['0', '-1', 'abc', '999999999999999999999', '1.5'] as $value) {
            $this->getJson('/api/products?page=' . $value)->assertUnprocessable()->assertJsonValidationErrors('page');
            $this->getJson('/api/products/' . $value)->assertNotFound();
        }
        $this->actingAs(User::factory()->create(), 'api');
        foreach ([0, -1, 31, '999999999999999999999', 1.5, null] as $quantity) {
            $this->postJson('/api/cart/items', ['product_id' => 1, 'quantity' => $quantity])
                ->assertUnprocessable()->assertJsonValidationErrors('quantity');
        }
        $this->postJson('/api/cart/items', ['product_id' => '999999999999999999999', 'quantity' => 1])
            ->assertUnprocessable()->assertJsonValidationErrors('product_id');
        $this->postJson('/api/orders', ['delivery_method' => 'teleport'])
            ->assertUnprocessable()->assertJsonValidationErrors('delivery_method');
    }

    public function test_legacy_report_errors_are_never_exposed(): void
    {
        $this->actingAs(User::factory()->admin()->create(), 'api');
        $report = Report::factory()->create(['error' => 'password=secret /var/private SQLSTATE minio:9000']);
        $response = $this->getJson('/api/reports/' . $report->id)->assertOk();
        self::assertSame(__('api.report.generation_unavailable'), $response->json('error'));
        self::assertStringNotContainsString('SQLSTATE', $response->getContent());
        self::assertStringNotContainsString('secret', $response->getContent());
    }
}
