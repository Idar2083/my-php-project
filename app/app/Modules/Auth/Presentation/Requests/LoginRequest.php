<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Requests;

use App\Http\Requests\ApiRequest;

class LoginRequest extends ApiRequest
{
    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'email' => ['required', 'string', 'email', 'max:255'],
            'password' => ['required', 'string', 'max:4096'],
        ];
    }
}
