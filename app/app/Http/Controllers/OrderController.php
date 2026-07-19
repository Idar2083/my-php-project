<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Controllers\Models\User;
use App\Http\Requests\StoreOrderRequest;
use App\Http\Resources\OrderResource;
use App\Services\OrderService;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

class OrderController extends Controller
{
    public function __construct(
        private OrderService $orderService,
    ) {
    }

    public function store(StoreOrderRequest $request): OrderResource
    {
        /** @var User $user */
        $user = $request->user();

        /**
         * @var array{
         *      region: string,
         *      city: string,
         *      street: string,
         *      house: string,
         *      entrance?: string|null,
         *      apartment?: string|null,
         *      postal_code: string
         *  } $validated
         */
        $validated = $request->validated();

        return new OrderResource(
            $this->orderService->create($user, $validated),
        );
    }

    public function index(Request $request): AnonymousResourceCollection
    {
        /** @var User $user */
        $user = $request->user();

        return OrderResource::collection(
            $this->orderService->getOrders($user),
        );
    }

    public function show(Request $request, int $orderId): OrderResource
    {
        /** @var User $user */
        $user = $request->user();

        return new OrderResource(
            $this->orderService->getOrder($user, $orderId),
        );
    }
}
