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

final class OrderReplayTest extends TestCase
{
    use RefreshDatabase;

    public function test_replaying_checkout_without_refilling_cart_does_not_create_another_order(): void
    {
        $buyer = User::factory()->create();
        $cart = Cart::factory()->for($buyer)->create();
        $product = Product::factory()->create(['price' => '12.50']);
        CartItem::factory()->for($cart)->for($product)->create(['quantity' => 2]);
        $this->withToken(JWTAuth::fromUser($buyer));
        $body = ['region' => 'Region', 'city' => 'City', 'street' => 'Street', 'house' => '1', 'postal_code' => '123456', 'delivery_method' => 'delivery'];
        $id = $this->postJson('/api/orders', $body)->assertCreated()->assertJsonPath('data.total_price', '25.00')->json('data.id');
        $this->postJson('/api/orders', $body)->assertUnprocessable()->assertJsonValidationErrors('cart')
            ->assertJsonMissingPath('trace')->assertJsonMissingPath('exception');
        $this->assertDatabaseCount('orders', 1);
        $this->assertDatabaseCount('order_items', 1);
        $this->assertDatabaseCount('cart_items', 0);
        $this->getJson('/api/orders/' . $id)->assertOk()->assertJsonPath('data.items.0.quantity', 2);
    }

    public function test_terminal_orders_reject_every_transition_including_repeat_completion_and_cancellation(): void
    {
        $admin = User::factory()->admin()->create();
        $order = Order::query()->create([
            'user_id' => $admin->id, 'total_price' => '25.00', 'delivery_method' => 'delivery',
            'region' => 'Region', 'city' => 'City', 'street' => 'Street', 'house' => '1', 'postal_code' => '123456',
        ]);
        $this->withToken(JWTAuth::fromUser($admin));
        foreach ([OrderStatus::COMPLETED, OrderStatus::CANCELLED] as $terminal) {
            $order->status = $terminal;
            $order->save();
            foreach (OrderStatus::cases() as $target) {
                $this->putJson('/api/orders/' . $order->id . '/status', ['status' => $target->value])->assertConflict()
                    ->assertJsonMissingPath('trace')->assertJsonMissingPath('exception');
                self::assertSame($terminal, $order->refresh()->status);
            }
        }
    }
}
