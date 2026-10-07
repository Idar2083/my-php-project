<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Requests;

use App\Http\Requests\ApiRequest;

final class IndexUsersRequest extends ApiRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ];
    }

    public function getPage(): int
    {
        return (int) $this->validated('page', 1);
    }

    public function getPerPage(): int
    {
        return (int) $this->validated('per_page', 20);
    }
}
