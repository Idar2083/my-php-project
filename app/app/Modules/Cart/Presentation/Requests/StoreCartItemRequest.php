<?php

declare(strict_types=1);

namespace App\Modules\Cart\Presentation\Requests;

use App\Http\Requests\ApiRequest;

class StoreCartItemRequest extends ApiRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'product_id' => ['required', 'integer', 'exists:products,id'],
            'quantity' => ['required', 'integer', 'min:1'],
        ];
    }
}
