<?php

declare(strict_types=1);

namespace Tests\Feature\Auth;

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class BrowserSessionTest extends TestCase
{
    use RefreshDatabase;

    private string $csrf;

    public function test_registration_restores_a_session_and_logout_revokes_its_cookie(): void
    {
        $this->getJson('/api/me')->assertUnauthorized();
        $original = $this->acceptCookies($this->getJson('/api/csrf-cookie')->assertNoContent());
        $password = bin2hex(random_bytes(16)) . '!Aa1';
        $details = ['name' => 'Buyer', 'email' => 'buyer@example.test', 'password' => $password];

        $this->postJson('/api/register', $details)->assertStatus(419);
        $this->withHeader('X-XSRF-TOKEN', 'invalid')->postJson('/api/register', $details)->assertStatus(419);
        $registration = $this->withHeader('X-XSRF-TOKEN', $this->csrf)->postJson('/api/register', $details);
        $registration->assertOk()->assertJsonPath('email', $details['email'])->assertJsonPath('role', 'user')->assertJsonMissingPath('token');
        $signedIn = $this->acceptCookies($registration);
        self::assertNotSame($original, $signedIn);

        $this->freshAuth();
        $this->getJson('/api/me')->assertOk()->assertJsonPath('email', $details['email']);
        $this->getJson('/api/cart')->assertOk();
        $this->getJson('/api/orders')->assertOk();
        $this->getJson('/api/admin/users')->assertForbidden();
        $this->getJson('/api/admin/orders')->assertForbidden();

        $bearer = JWTAuth::fromUser(User::query()->where('email', $details['email'])->firstOrFail());
        $this->withHeader('X-XSRF-TOKEN', $this->csrf)->postJson('/api/logout')->assertOk();
        $this->freshAuth();
        $this->getJson('/api/me')->assertUnauthorized();
        $this->getJson('/api/cart')->assertUnauthorized();
        $this->freshAuth();
        $this->withToken($bearer)->getJson('/api/me')->assertOk()
            ->assertJsonPath('email', $details['email'])->assertCookieMissing(config('session.cookie'));
        $this->withoutHeader('Authorization');
        $this->freshAuth();

        $this->acceptCookies($this->getJson('/api/csrf-cookie')->assertNoContent());
        $this->withHeader('X-XSRF-TOKEN', $this->csrf)->postJson('/api/login', [
            'email' => $details['email'],
            'password' => $password,
        ])->assertOk()->assertJsonPath('email', $details['email']);
    }

    public function test_login_rotates_session_and_expired_session_requires_login(): void
    {
        $password = bin2hex(random_bytes(16)) . '!Aa1';
        $user = User::factory()->create(['password' => $password]);
        $original = $this->acceptCookies($this->getJson('/api/csrf-cookie')->assertNoContent());
        $login = $this->withHeader('X-XSRF-TOKEN', $this->csrf)->postJson('/api/login', [
            'email' => $user->email,
            'password' => $password,
        ])->assertOk()->assertJsonPath('id', $user->id);
        $signedIn = $this->acceptCookies($login);
        self::assertNotSame($original, $signedIn);

        $this->freshAuth();
        $this->getJson('/api/me')->assertOk()->assertJsonPath('id', $user->id);

        $this->travel(config('session.lifetime') + 1)->minutes();
        $this->freshAuth();
        $expired = $this->getJson('/api/me')->assertUnauthorized();
        self::assertNotSame($signedIn, $this->acceptCookies($expired));
    }

    public function test_bearer_remains_stateless_and_a_foreign_origin_cannot_start_a_browser_session(): void
    {
        $this->withHeader('Origin', 'https://untrusted.example')->getJson('/api/csrf-cookie')->assertForbidden();

        $token = JWTAuth::fromUser(User::factory()->create());
        $this->withToken($token)->getJson('/api/me')->assertOk()->assertCookieMissing(config('session.cookie'));
        $this->getJson('/api/admin/orders')->assertForbidden();
        $this->postJson('/api/logout')->assertOk();
        $this->freshAuth();
        $this->getJson('/api/me')->assertUnauthorized();
    }

    public function test_admin_session_can_manage_roles_with_csrf(): void
    {
        $password = bin2hex(random_bytes(16)) . '!Aa1';
        $admin = User::factory()->create(['role' => UserRole::ADMIN, 'password' => $password]);
        $buyer = User::factory()->create();
        $this->acceptCookies($this->getJson('/api/csrf-cookie')->assertNoContent());
        $this->acceptCookies($this->withHeader('X-XSRF-TOKEN', $this->csrf)->postJson('/api/login', [
            'email' => $admin->email,
            'password' => $password,
        ])->assertOk());
        $this->freshAuth();
        $this->getJson('/api/admin/users')->assertOk();

        $path = '/api/admin/users/' . $buyer->id . '/role';
        $this->withoutHeader('X-XSRF-TOKEN')->patchJson($path, ['role' => 'admin'])->assertStatus(419);
        $this->withHeader('X-XSRF-TOKEN', $this->csrf)->patchJson($path, ['role' => 'admin'])->assertOk();
        self::assertSame(UserRole::ADMIN, $buyer->refresh()->role);
    }

    public function test_failed_insert_does_not_report_a_successful_login_or_issue_cookies(): void
    {
        $password = bin2hex(random_bytes(16)) . '!Aa1';
        $user = User::factory()->create(['password' => $password]);
        $this->acceptCookies($this->getJson('/api/csrf-cookie')->assertNoContent());

        $occupiedId = Str::random(40);
        $row = ['id' => $occupiedId, 'user_id' => null, 'payload' => base64_encode('{}'), 'last_activity' => time()];
        DB::table('sessions')->insert($row);
        Str::createRandomStringsUsing(static fn (int $length): string => $length === 40
            ? $occupiedId
            : substr(bin2hex(random_bytes($length)), 0, $length));
        try {
            $this->withHeader('X-XSRF-TOKEN', $this->csrf)->postJson('/api/login', [
                'email' => $user->email,
                'password' => $password,
            ])->assertStatus(503)->assertCookieMissing(config('session.cookie'))->assertCookieMissing('XSRF-TOKEN');
        } finally {
            Str::createRandomStringsNormally();
        }

        $this->assertDatabaseHas('sessions', $row);
    }

    protected function setUp(): void
    {
        parent::setUp();

        // Exercise the real CSRF middleware, which Laravel skips in the testing environment.
        $this->app->instance('env', 'local');
        config(['session.driver' => 'database', 'session.secure' => true, 'session.domain' => null]);
        $this->withCredentials()->withHeaders(['X-Pizza-Client' => 'spa', 'Origin' => 'http://localhost']);
    }

    private function acceptCookies(TestResponse $response): string
    {
        $name = config('session.cookie');
        $cookie = $response->getCookie($name, false);
        self::assertNotNull($cookie);
        self::assertTrue($cookie->isHttpOnly());
        self::assertTrue($cookie->isSecure());
        self::assertSame('lax', $cookie->getSameSite());
        self::assertEmpty($cookie->getDomain());
        self::assertSame('/', $cookie->getPath());
        $csrf = $response->getCookie('XSRF-TOKEN', false);
        self::assertNotNull($csrf);
        self::assertFalse($csrf->isHttpOnly());
        $this->csrf = $csrf->getValue();
        $this->withUnencryptedCookie($name, $cookie->getValue());

        return $response->getCookie($name)->getValue();
    }

    private function freshAuth(): void
    {
        $this->app['auth']->forgetGuards();
        $this->app['session']->forgetDrivers();
        $this->app->forgetInstance('session.store');
        $this->app['tymon.jwt']->unsetToken();
    }
}
