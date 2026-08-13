<?php

declare(strict_types=1);

namespace App\Modules\Cart\Presentation\Requests;

use App\Http\Requests\ApiRequest;

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
