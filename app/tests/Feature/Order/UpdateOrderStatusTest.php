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
use Symfony\Component\HttpFoundation\Response;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class UpdateOrderStatusTest extends TestCase
{
    use RefreshDatabase;

    private User $user;

    public function test_cannot_update_completed_order(): void
    {
        $order = $this->createOrder();

        $order->update([
            'status' => OrderStatus::COMPLETED,
        ]);

        $this->putJson(
            '/api/orders/' . $order->id . '/status',
            [
                'status' => OrderStatus::PAID->value,
            ],
        )
            ->assertStatus(Response::HTTP_CONFLICT)
            ->assertJson([
                'message' => 'Cannot update status of a completed order.',
            ]);
    }

    public function test_cannot_update_cancelled_order(): void
    {
        $order = $this->createOrder();

        $order->update([
            'status' => OrderStatus::CANCELLED,
        ]);

        $this->putJson(
            '/api/orders/' . $order->id . '/status',
            [
                'status' => OrderStatus::PAID->value,
            ],
        )
            ->assertStatus(Response::HTTP_CONFLICT)
            ->assertJson([
                'message' => 'Cannot update status of a cancelled order.',
            ]);
    }

    public function test_translatable_exception_uses_russian_locale_without_exposing_internal_details(): void
    {
        $order = $this->createOrder();

        $order->update([
            'status' => OrderStatus::COMPLETED,
        ]);

        $this->withHeader('Accept-Language', 'ru')
            ->putJson(
                '/api/orders/' . $order->id . '/status',
                [
                    'status' => OrderStatus::PAID->value,
                ],
            )
            ->assertStatus(Response::HTTP_CONFLICT)
            ->assertJson([
                'message' => 'Невозможно изменить статус заказа со статусом «completed».',
            ])
            ->assertJsonMissingPath('trace')
            ->assertJsonMissingPath('exception')
            ->assertJsonMissingPath('file')
            ->assertJsonMissingPath('line');
    }

    public function test_unknown_locale_falls_back_to_english(): void
    {
        $order = $this->createOrder();

        $order->update([
            'status' => OrderStatus::COMPLETED,
        ]);

        $this->withHeader('Accept-Language', 'de')
            ->putJson(
                '/api/orders/' . $order->id . '/status',
                [
                    'status' => OrderStatus::PAID->value,
                ],
            )
            ->assertStatus(Response::HTTP_CONFLICT)
            ->assertJson([
                'message' => 'Cannot update status of a completed order.',
            ]);
    }

    public function test_non_admin_user_gets_russian_forbidden_response(): void
    {
        $user = User::factory()->create();

        $token = JWTAuth::fromUser($user);

        $this->withHeaders([
            'Authorization' => "Bearer $token",
            'Accept-Language' => 'ru',
        ])
            ->postJson('/api/reports', [
                'date_from' => '2026-01-01',
                'date_to' => '2026-01-31',
            ])
            ->assertStatus(Response::HTTP_FORBIDDEN)
            ->assertExactJson([
                'message' => 'Доступ запрещен.',
            ]);
    }

    public function test_non_admin_user_unknown_locale_falls_back_to_english_forbidden_response(): void
    {
        $user = User::factory()->create();

        $token = JWTAuth::fromUser($user);

        $this->withHeaders([
            'Authorization' => "Bearer $token",
            'Accept-Language' => 'de',
        ])
            ->postJson('/api/reports', [
                'date_from' => '2026-01-01',
                'date_to' => '2026-01-31',
            ])
            ->assertStatus(Response::HTTP_FORBIDDEN)
            ->assertExactJson([
                'message' => 'Forbidden.',
            ]);
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->user = User::factory()
            ->admin()
            ->create();

        $this->withHeader(
            'Authorization',
            'Bearer ' . JWTAuth::fromUser($this->user),
        );
    }

    private function createOrder(): Order
    {
        $product = Product::factory()->create([
            'name' => 'Pepperoni',
            'price' => 500,
        ]);

        Cart::factory()
            ->for($this->user, 'user')
            ->has(
                CartItem::factory()
                    ->for($product, 'product')
                    ->state([
                        'quantity' => 1,
                    ]),
                'items',
            )
            ->create();

        $response = $this->postJson(
            '/api/orders',
            [
                'delivery_method' => 'delivery',
                'region' => 'Moscow Region',
                'city' => 'Moscow',
                'street' => 'Tverskaya',
                'house' => '1',
                'postal_code' => '125009',
            ],
        );

        $response->assertCreated();

        return Order::query()->findOrFail(
            $response->json('data.id'),
        );
    }
}
