<?php

declare(strict_types=1);

namespace App\Modules\Order\Presentation\Controllers;

use App\Modules\Order\Application\Services\OrderService;
use App\Modules\Order\Presentation\Requests\IndexOrdersRequest;
use App\Modules\Order\Presentation\Resources\AdminOrderResource;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;

final readonly class AdminOrderController
{
    public function __construct(private OrderService $orderService)
    {
    }

    public function index(IndexOrdersRequest $request): AnonymousResourceCollection
    {
        return AdminOrderResource::collection($this->orderService->getAdminOrders($request->getPage()));
    }

    public function show(int $orderId): AdminOrderResource
    {
        return new AdminOrderResource($this->orderService->getAdminOrder($orderId));
    }
}
