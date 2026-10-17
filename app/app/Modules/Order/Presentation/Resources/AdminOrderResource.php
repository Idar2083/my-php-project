<?php

declare(strict_types=1);

namespace App\Modules\Order\Presentation\Resources;

use App\Modules\Order\Domain\Enums\OrderStatus;

final class AdminOrderResource extends OrderResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray($request): array
    {
        $status = $this->resource->status;
        $transitions = in_array($status, [OrderStatus::COMPLETED, OrderStatus::CANCELLED], true)
            ? []
            : array_values(array_filter(OrderStatus::cases(), static fn (OrderStatus $candidate): bool => $candidate !== $status));

        return array_merge(parent::toArray($request), [
            'customer' => [
                'id' => $this->resource->user->id,
                'name' => $this->resource->user->name,
                'email' => $this->resource->user->email,
            ],
            'allowed_statuses' => array_map(static fn (OrderStatus $candidate): string => $candidate->value, $transitions),
        ]);
    }
}
