<?php

declare(strict_types=1);

namespace App\Modules\Cart\Presentation\Requests;

use App\Http\Requests\ApiRequest;

final class ImportCartRequest extends ApiRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'items' => ['required', 'array', 'list', 'min:1', 'max:30'],
            'items.*' => ['required', 'array:product_id,quantity'],
            'items.*.product_id' => ['required', 'bail', 'integer', 'min:1', 'max:9223372036854775807', 'distinct', 'exists:products,id'],
            'items.*.quantity' => ['required', 'integer', 'min:1', 'max:30'],
        ];
    }
}
