<?php

declare(strict_types=1);

namespace App\Modules\Order\Presentation\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class OrderResource extends JsonResource
{
    /**
     * @return array<string,mixed>
     */
    public function toArray($request): array
    {
        return [
            'id' => $this->resource->id,
            'status' => $this->resource->status,
            'total_price' => $this->resource->total_price,
            'delivery_method' => $this->resource->delivery_method,
            'address' => [
                'region' => $this->resource->region,
                'city' => $this->resource->city,
                'street' => $this->resource->street,
                'house' => $this->resource->house,
                'entrance' => $this->resource->entrance,
                'apartment' => $this->resource->apartment,
                'postal_code' => $this->resource->postal_code,
            ],
            'items' => OrderItemResource::collection(
                $this->whenLoaded('items'),
            ),
            'created_at' => $this->resource->created_at,
        ];
    }
}
