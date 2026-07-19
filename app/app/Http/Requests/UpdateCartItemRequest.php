<?php

declare(strict_types=1);

namespace App\Http\Requests;

class UpdateCartItemRequest extends ApiRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'quantity' => ['required', 'integer', 'min:1'],
        ];
    }
}
