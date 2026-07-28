<?php

declare(strict_types=1);

namespace App\Http\Resources;

use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

class CartItemResource extends JsonResource
{
    /**
     * @return array<string, mixed>
     */
    public function toArray(Request $request): array
    {
        return [
            'id' => $this->resource->id,
            'product_id' => $this->resource->product_id,
            'quantity' => $this->resource->quantity,
            'product' => new ProductResource($this->whenLoaded('product')),
        ];
    }
}
