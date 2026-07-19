<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Controllers\Models\User;
use App\Http\Requests\StoreCartItemRequest;
use App\Http\Requests\UpdateCartItemRequest;
use App\Http\Resources\CartResource;
use App\Services\CartService;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class CartController extends Controller
{
    public function __construct(
        private readonly CartService $cartService,
    ) {
    }

    public function show(Request $request): CartResource
    {
        /** @var User $user */
        $user = $request->user();

        return new CartResource(
            $this->cartService->getCart($user),
        );
    }

    public function store(StoreCartItemRequest $request): CartResource
    {
        /** @var User $user */
        $user = $request->user();

        /** @var array{product_id: int, quantity: int} $validated */
        $validated = $request->validated();

        return new CartResource(
            $this->cartService->addItem(
                $user,
                $validated['product_id'],
                $validated['quantity'],
            ),
        );
    }

    public function update(
        UpdateCartItemRequest $request,
        int $itemId,
    ): CartResource {
        /** @var User $user */
        $user = $request->user();

        /** @var array{quantity: int} $validated */
        $validated = $request->validated();

        return new CartResource(
            $this->cartService->updateItem(
                $user,
                $itemId,
                $validated['quantity'],
            ),
        );
    }

    public function destroy(Request $request, int $itemId): CartResource
    {
        /** @var User $user */
        $user = $request->user();

        return new CartResource(
            $this->cartService->removeItem($user, $itemId),
        );
    }

    public function clear(Request $request): Response
    {
        /** @var User $user */
        $user = $request->user();

        $this->cartService->clear($user);

        return response()->noContent();
    }
}
