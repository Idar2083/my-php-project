<?php

declare(strict_types=1);

namespace App\Modules\Cart\Presentation\Controllers;

use App\Http\Controllers\Controller;
use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Application\Services\CartService;
use App\Modules\Cart\Presentation\Requests\StoreCartItemRequest;
use App\Modules\Cart\Presentation\Requests\UpdateCartItemRequest;
use App\Modules\Cart\Presentation\Resources\CartResource;
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
