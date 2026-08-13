<?php

declare(strict_types=1);

namespace App\Modules\Order\Presentation\Controllers;

use App\Http\Controllers\Controller;
use App\Modules\Auth\Domain\Models\User;
use App\Modules\Order\Application\DTO\AddressDto;
use App\Modules\Order\Application\Services\OrderService;
use App\Modules\Order\Presentation\Requests\StoreOrderRequest;
use App\Modules\Order\Presentation\Resources\OrderResource;
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
         *     delivery_method: string,
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

        $address = AddressDto::fromArray($validated);

        return new OrderResource(
            $this->orderService->create($user, $address),
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
