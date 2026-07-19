<?php

declare(strict_types=1);

namespace App\Http\Requests;

class StoreOrderRequest extends ApiRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'region' => ['required', 'string', 'max:255'],
            'city' => ['required', 'string', 'max:255'],
            'street' => ['required', 'string', 'max:255'],
            'house' => ['required', 'string', 'max:255'],
            'apartment' => ['nullable', 'string', 'max:255'],
            'entrance' => ['nullable', 'string', 'max:255'],
            'postal_code' => ['required', 'string', 'max:255'],
        ];
    }
}
