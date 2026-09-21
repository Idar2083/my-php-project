<?php

declare(strict_types=1);

namespace App\Modules\Cart\Application\Services;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Cart\Domain\Models\CartItem;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Database\QueryException;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class CartService
{
    private const int TRANSACTION_ATTEMPTS = 3;

    private const string POSTGRES_UNIQUE_VIOLATION = '23505';

    public function getCart(User $user): Cart
    {
        $cart = Cart::query()->firstOrCreate([
            'user_id' => $user->id,
        ]);

        $cart->wasRecentlyCreated = false;

        return $cart->load('items.product');
    }

    public function addItem(User $user, int $productId, int $quantity): Cart
    {
        return DB::transaction(function () use ($user, $productId, $quantity): Cart {
            $cart = $this->getOrCreateCart($user);

            $product = Product::query()->findOrFail($productId);

            $item = CartItem::query()
                ->where('cart_id', $cart->id)
                ->where('product_id', $product->id)
                ->lockForUpdate()
                ->first();

            $newQuantity = ($item === null ? 0 : (int) $item->quantity) + $quantity;

            $this->validateCategoryLimit(
                $cart,
                $product,
                $newQuantity,
                $item?->id,
            );

            if ($item === null) {
                CartItem::query()->create([
                    'cart_id' => $cart->id,
                    'product_id' => $product->id,
                    'quantity' => $newQuantity,
                ]);
            } else {
                $item->update([
                    'quantity' => $newQuantity,
                ]);
            }

            return $cart->load('items.product');
        }, self::TRANSACTION_ATTEMPTS);
    }

    public function updateItem(User $user, int $itemId, int $quantity): Cart
    {
        return DB::transaction(function () use ($user, $itemId, $quantity): Cart {
            $cart = Cart::query()
                ->where('user_id', $user->id)
                ->lockForUpdate()
                ->firstOrFail();

            $item = CartItem::query()
                ->where('id', $itemId)
                ->where('cart_id', $cart->id)
                ->lockForUpdate()
                ->firstOrFail();

            $product = Product::query()->findOrFail($item->product_id);

            $this->validateCategoryLimit(
                $cart,
                $product,
                $quantity,
                $item->id,
            );

            $item->update([
                'quantity' => $quantity,
            ]);

            return $cart->load('items.product');
        }, self::TRANSACTION_ATTEMPTS);
    }

    public function removeItem(User $user, int $itemId): Cart
    {
        return DB::transaction(function () use ($user, $itemId): Cart {
            $cart = Cart::query()
                ->where('user_id', $user->id)
                ->lockForUpdate()
                ->firstOrFail();

            $item = CartItem::query()
                ->where('id', $itemId)
                ->where('cart_id', $cart->id)
                ->lockForUpdate()
                ->firstOrFail();

            $item->delete();

            return $cart->load('items.product');
        }, self::TRANSACTION_ATTEMPTS);
    }

    public function clear(User $user): Cart
    {
        return DB::transaction(function () use ($user): Cart {
            $cart = Cart::query()
                ->where('user_id', $user->id)
                ->lockForUpdate()
                ->firstOrFail();

            CartItem::query()
                ->where('cart_id', $cart->id)
                ->delete();

            return $cart->load('items.product');
        }, self::TRANSACTION_ATTEMPTS);
    }

    private function getOrCreateCart(User $user): Cart
    {
        $cart = Cart::query()
            ->where('user_id', $user->id)
            ->lockForUpdate()
            ->first();

        if ($cart !== null) {
            $cart->wasRecentlyCreated = false;

            return $cart;
        }

        try {
            $cart = Cart::query()->create([
                'user_id' => $user->id,
            ]);

            $cart->wasRecentlyCreated = false;

            return $cart;
        } catch (QueryException $exception) {
            if ($exception->getCode() !== self::POSTGRES_UNIQUE_VIOLATION) {
                throw $exception;
            }
        }

        $cart = Cart::query()
            ->where('user_id', $user->id)
            ->lockForUpdate()
            ->firstOrFail();

        $cart->wasRecentlyCreated = false;

        return $cart;
    }

    private function validateCategoryLimit(
        Cart $cart,
        Product $product,
        int $newQuantity,
        ?int $excludedItemId = null,
    ): void {
        $query = CartItem::query()
            ->where('cart_id', $cart->id)
            ->whereHas('product', static function ($query) use ($product): void {
                $query->where('category', $product->category);
            });

        if ($excludedItemId !== null) {
            $query->where('id', '!=', $excludedItemId);
        }

        $currentQuantity = (int) $query->sum('quantity');
        $totalQuantity = $currentQuantity + $newQuantity;

        $limit = match ($product->category) {
            'pizza' => Cart::MAX_PIZZAS,
            'drink' => Cart::MAX_DRINKS,
            default => throw ValidationException::withMessages([
                'product_id' => [
                    __('api.cart.unsupported_category'),
                ],
            ]),
        };

        if ($totalQuantity > $limit) {
            throw ValidationException::withMessages([
                'quantity' => [
                    __('api.cart.max_items', [
                        'category' => __(
                            'api.categories.' . $product->category,
                        ),
                        'limit' => $limit,
                    ]),
                ],
            ]);
        }
    }
}
