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
            'email' => ['required', 'email'],
            'password' => ['required'],
        ];
    }
}
