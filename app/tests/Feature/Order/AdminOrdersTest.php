<?php

declare(strict_types=1);

namespace Tests\Feature\Order;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Cart\Domain\Models\CartItem;
use App\Modules\Catalog\Domain\Models\Product;
use App\Modules\Order\Domain\Enums\OrderStatus;
use App\Modules\Order\Domain\Models\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class AdminOrdersTest extends TestCase
{
    use RefreshDatabase;

    public function test_guest_and_buyer_cannot_access_admin_orders_or_other_buyers_orders(): void
    {
        $owner = User::factory()->create();
        $order = $this->orderFor($owner);
        $this->asApiUser(null);
        $this->getJson('/api/admin/orders')->assertUnauthorized();
        $this->getJson('/api/admin/orders/' . $order->id)->assertUnauthorized();
        $this->withToken('invalid')->getJson('/api/admin/orders')->assertUnauthorized();
        $buyer = User::factory()->create();
        $this->asApiUser($buyer);
        $this->getJson('/api/admin/orders')->assertForbidden();
        $this->getJson('/api/admin/orders/' . $order->id)->assertForbidden();
        $this->getJson('/api/orders/' . $order->id)->assertNotFound();
        $this->getJson('/api/orders')->assertOk()->assertJsonPath('data', []);
        $this->putJson('/api/orders/' . $order->id . '/status', ['status' => 'paid'])->assertForbidden();
        self::assertSame(OrderStatus::CREATED, $order->refresh()->status);
    }

    public function test_admin_sees_customer_snapshot_items_and_server_total(): void
    {
        $owner = User::factory()->create();
        $order = $this->orderFor($owner);
        Product::query()->whereKey($order->items->first()->product_id)->update(['name' => 'Renamed']);
        $this->asApiUser(User::factory()->admin()->create());
        $this->getJson('/api/admin/orders')->assertOk()->assertJsonPath('meta.per_page', 30)
            ->assertJsonPath('data.0.id', $order->id)->assertJsonPath('data.0.customer.email', $owner->email)
            ->assertJsonMissingPath('data.0.customer.password')->assertJsonMissingPath('data.0.customer.role');
        $detail = $this->getJson('/api/admin/orders/' . $order->id)->assertOk()
            ->assertJsonPath('data.customer.id', $owner->id)->assertJsonPath('data.items.0.product_name', 'Original pizza')
            ->assertJsonPath('data.items.0.quantity', 2)->assertJsonPath('data.items.0.price', '12.50')
            ->assertJsonPath('data.total_price', '25.00');
        foreach ($detail->json('data.allowed_statuses') as $status) {
            $this->putJson('/api/orders/' . $order->id . '/status', ['status' => $status])->assertOk();
            // Restore only the test fixture to check each transition from CREATED.
            $order->refresh();
            $order->status = OrderStatus::CREATED;
            $order->save();
        }
        $this->putJson('/api/orders/' . $order->id . '/status', ['status' => 'unsupported'])->assertUnprocessable()->assertJsonValidationErrors('status');
        $this->getJson('/api/admin/orders/9223372036854775808')->assertNotFound();
        $this->getJson('/api/admin/orders/999999')->assertNotFound();
        foreach (['0', '-1', 'huge', '1000001'] as $page) {
            $this->getJson('/api/admin/orders?page=' . $page)->assertUnprocessable()->assertJsonValidationErrors('page');
        }
        $this->getJson('/api/admin/orders?page=2')->assertOk()->assertJsonPath('data', []);
    }

    public function test_admin_pagination_has_stable_order_without_duplicates(): void
    {
        $order = $this->orderFor(User::factory()->create());
        for ($i = 0; $i < 30; ++$i) {
            $order->replicate()->save();
        }
        $this->asApiUser(User::factory()->admin()->create());
        $first = $this->getJson('/api/admin/orders')->assertOk()->assertJsonCount(30, 'data')
            ->assertJsonPath('meta.total', 31)->assertJsonPath('meta.last_page', 2);
        $second = $this->getJson('/api/admin/orders?page=2')->assertOk()->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $order->id);
        self::assertSame([], array_intersect(array_column($first->json('data'), 'id'), array_column($second->json('data'), 'id')));
    }

    public function test_closed_orders_offer_no_transitions_and_reject_changes(): void
    {
        $order = $this->orderFor(User::factory()->create());
        $this->asApiUser(User::factory()->admin()->create());
        foreach ([OrderStatus::COMPLETED, OrderStatus::CANCELLED] as $status) {
            $order->status = $status;
            $order->save();
            $this->getJson('/api/admin/orders/' . $order->id)->assertOk()->assertJsonPath('data.allowed_statuses', []);
            $this->putJson('/api/orders/' . $order->id . '/status', ['status' => 'paid'])->assertConflict();
            self::assertSame($status, $order->refresh()->status);
        }
    }

    private function asApiUser(?User $user): void
    {
        $token = $user === null ? '' : JWTAuth::fromUser($user);
        $this->app['auth']->forgetGuards();
        $this->app['tymon.jwt']->unsetToken();
        $this->withHeader('Authorization', $token === '' ? '' : 'Bearer ' . $token);
    }

    private function orderFor(User $user): Order
    {
        $product = Product::factory()->create(['name' => 'Original pizza', 'price' => 12.50]);
        $cart = Cart::factory()->for($user)->create();
        CartItem::factory()->for($cart)->for($product)->create(['quantity' => 2]);
        $this->asApiUser($user);
        $response = $this->postJson('/api/orders', [
            'region' => 'Region', 'city' => 'City', 'street' => 'Street', 'house' => '1',
            'postal_code' => '123456', 'delivery_method' => 'delivery',
        ])->assertCreated();

        return Order::query()->with('items')->findOrFail($response->json('data.id'));
    }
}
