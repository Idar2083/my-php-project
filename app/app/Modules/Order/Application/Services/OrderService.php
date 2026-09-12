<?php

declare(strict_types=1);

namespace App\Modules\Order\Application\Services;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Order\Domain\Enums\OrderStatus;
use App\Modules\Order\Domain\Models\DTO\AddressDto;
use App\Modules\Order\Domain\Models\Order;
use App\Modules\Order\Domain\Models\OrderItem;
use Illuminate\Database\Eloquent\Collection;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class OrderService
{
    private const int MAX_ORDER_ITEMS = 30;

    public function create(User $user, AddressDto $address): Order
    {
        return DB::transaction(function () use ($user, $address): Order {
            $cart = Cart::query()
                ->where('user_id', $user->id)
                ->lockForUpdate()
                ->first();

            if ($cart === null || $cart->items->isEmpty()) {
                throw ValidationException::withMessages([
                    'cart' => ['The cart must contain at least one product.'],
                ]);
            }

            $totalItems = (int) $cart->items->sum('quantity');

            if ($totalItems > self::MAX_ORDER_ITEMS) {
                throw ValidationException::withMessages([
                    'cart' => [
                        sprintf(
                            'The maximum order size is %d items.',
                            self::MAX_ORDER_ITEMS,
                        ),
                    ],
                ]);
            }

            $totalPrice = 0.0;

            foreach ($cart->items as $item) {
                $totalPrice += (float) $item->product->price * $item->quantity;
            }

            $order = Order::query()->create([
                'user_id' => $user->id,
                'status' => OrderStatus::CREATED,
                'total_price' => $totalPrice,
                'delivery_method' => $address->deliveryMethod,
                'region' => $address->region,
                'city' => $address->city,
                'street' => $address->street,
                'house' => $address->house,
                'entrance' => $address->entrance,
                'apartment' => $address->apartment,
                'postal_code' => $address->postalCode,
            ]);

            foreach ($cart->items as $item) {
                OrderItem::query()->create([
                    'order_id' => $order->id,
                    'product_id' => $item->product_id,
                    'product_name' => $item->product->name,
                    'quantity' => $item->quantity,
                    'price' => $item->product->price,
                ]);
            }

            $cart->items()->delete();

            return $order->load('items.product');
        });
    }

    /**
     * @return Collection<int, Order>
     */
    public function getOrders(User $user): Collection
    {
        return Order::query()
            ->where('user_id', $user->id)
            ->with('items.product')
            ->latest()
            ->get();
    }

    public function getOrder(User $user, int $orderId): Order
    {
        return Order::query()
            ->where('user_id', $user->id)
            ->with('items.product')
            ->findOrFail($orderId);
    }

    public function updateStatus(
        int $orderId,
        OrderStatus $status,
    ): Order {
        return DB::transaction(function () use ($orderId, $status): Order {
            /** @var Order $order */
            $order = Order::query()
                ->lockForUpdate()
                ->findOrFail($orderId);

            if (
                $order->status === OrderStatus::CANCELLED
                || $order->status === OrderStatus::COMPLETED
            ) {
                throw new \DomainException(
                    sprintf(
                        'Cannot update status of a %s order.',
                        $order->status->value,
                    ),
                );
            }

            $order->status = $status;

            if (
                $status === OrderStatus::PAID
                && $order->paid_at === null
            ) {
                $order->paid_at = now();
            }

            $order->save();

            return $order->refresh()->load('items.product');
        });
    }
}
