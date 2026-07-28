<?php

declare(strict_types=1);

namespace App\Http\Resources;

use Illuminate\Http\Resources\Json\JsonResource;

class OrderItemResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray($request): array
    {
        return [
            'id' => $this->resource->id,
            'product_id' => $this->resource->product_id,
            'quantity' => $this->resource->quantity,
            'price' => $this->resource->price,
            'product' => new ProductResource($this->whenLoaded('product')),
        ];
    }
}
