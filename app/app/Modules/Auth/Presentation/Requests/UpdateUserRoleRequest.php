<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Requests;

use App\Http\Requests\ApiRequest;
use App\Modules\Auth\Domain\Enums\UserRole;
use Illuminate\Validation\Rules\Enum;

final class UpdateUserRoleRequest extends ApiRequest
{
    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'role' => ['required', 'string', new Enum(UserRole::class)],
        ];
    }

    public function getRole(): UserRole
    {
        return UserRole::from($this->validated('role'));
    }
}
