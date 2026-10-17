<?php

declare(strict_types=1);

namespace Tests\Feature\Order;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Order\Domain\Models\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class OrderHistoryPaginationTest extends TestCase
{
    use RefreshDatabase;

    public function test_history_pagination_is_opt_in_stable_and_scoped_to_the_buyer(): void
    {
        $buyer = User::factory()->create();
        $other = User::factory()->create();
        $ids = [];
        for ($i = 0; $i < 31; ++$i) {
            $ids[] = $this->orderFor($buyer)->id;
        }
        $foreign = $this->orderFor($other);
        $this->withToken(JWTAuth::fromUser($buyer));
        $legacy = $this->getJson('/api/orders')->assertOk()->assertJsonCount(31, 'data')->assertJsonMissingPath('meta');
        $first = $this->getJson('/api/orders?page=1')->assertOk()->assertJsonCount(30, 'data')
            ->assertJsonPath('meta.total', 31)->assertJsonPath('meta.per_page', 30)->assertJsonPath('meta.last_page', 2);
        $second = $this->getJson('/api/orders?page=2')->assertOk()->assertJsonCount(1, 'data');
        $actual = array_merge(array_column($first->json('data'), 'id'), array_column($second->json('data'), 'id'));
        self::assertSame(array_reverse($ids), $actual);
        self::assertSame(array_column($legacy->json('data'), 'id'), $actual);
        self::assertNotContains($foreign->id, $actual);
        $this->getJson('/api/orders?page=3')->assertOk()->assertJsonPath('data', []);
        $this->getJson('/api/orders/' . $foreign->id)->assertNotFound();
    }

    public function test_invalid_pages_are_rejected_and_empty_history_has_pagination_metadata(): void
    {
        $this->withToken(JWTAuth::fromUser(User::factory()->create()));
        foreach (['0', '-1', '1000001', '1.5', 'abc', '999999999999999999999', ''] as $page) {
            $this->getJson('/api/orders?page=' . $page)->assertUnprocessable()->assertJsonValidationErrors('page');
        }
        $this->getJson('/api/orders?page[]=1')->assertUnprocessable()->assertJsonValidationErrors('page');
        $this->getJson('/api/orders?page=1')->assertOk()->assertJsonPath('data', [])->assertJsonPath('meta.total', 0);
    }

    private function orderFor(User $user): Order
    {
        return Order::query()->create([
            'user_id' => $user->id, 'total_price' => '25.00', 'delivery_method' => 'delivery',
            'region' => 'Region', 'city' => 'City', 'street' => 'Street', 'house' => '1', 'postal_code' => '123456',
        ]);
    }
}
