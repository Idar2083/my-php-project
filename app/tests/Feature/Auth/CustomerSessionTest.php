<?php

declare(strict_types=1);

namespace Tests\Feature\Auth;

use App\Modules\Auth\Domain\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class CustomerSessionTest extends TestCase
{
    use RefreshDatabase;

    public function test_expired_signed_jwt_cannot_access_private_data_or_expose_debug_details(): void
    {
        config(['app.debug' => true]);
        JWTAuth::factory()->setTTL(1);
        $token = JWTAuth::fromUser(User::factory()->create());
        $this->travel(2)->minutes();
        try {
            $this->withToken($token)->getJson('/api/me')->assertUnauthorized()
                ->assertExactJson(['message' => __('api.authorization.unauthenticated')]);
        } finally {
            $this->travelBack();
        }
    }

    public function test_logout_revokes_the_jwt_for_subsequent_fresh_requests(): void
    {
        $token = JWTAuth::fromUser(User::factory()->create());
        $this->withToken($token)->postJson('/api/logout')->assertOk();
        $this->app['auth']->forgetGuards();
        $this->app['tymon.jwt']->unsetToken();
        $this->withToken($token)->getJson('/api/orders?page=1')->assertUnauthorized()
            ->assertExactJson(['message' => __('api.authorization.unauthenticated')]);
    }
}
