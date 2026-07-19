<?php

declare(strict_types=1);

namespace App\Services;

use App\Http\Controllers\Models\Cart;
use App\Http\Controllers\Models\CartItem;
use App\Http\Controllers\Models\Product;
use App\Http\Controllers\Models\User;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

class CartService
{
    private const int MAX_PIZZAS = 10;

    private const int MAX_DRINKS = 20;

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
            $cart = Cart::query()
                ->where('user_id', $user->id)
                ->lockForUpdate()
                ->first();

            if ($cart === null) {
                $cart = Cart::query()->create([
                    'user_id' => $user->id,
                ]);

                $cart->refresh();

            }

            $cart->wasRecentlyCreated = false;

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
        });
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
        });
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
        });
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
        });
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
            'pizza' => self::MAX_PIZZAS,
            'drink' => self::MAX_DRINKS,
            default => throw ValidationException::withMessages([
                'product_id' => ['Unsupported product category.'],
            ]),
        };

        if ($totalQuantity > $limit) {
            throw ValidationException::withMessages([
                'quantity' => [
                    sprintf(
                        'The maximum number of %s items in the cart is %d.',
                        $product->category,
                        $limit,
                    ),
                ],
            ]);
        }
    }
}
