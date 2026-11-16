<?php

declare(strict_types=1);

namespace App\Modules\Order\Presentation\Requests;

use App\Http\Requests\ApiRequest;

final class IndexOrdersRequest extends ApiRequest
{
    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return ['page' => ['sometimes', 'integer', 'min:1', 'max:1000000']];
    }

    public function getPage(): int
    {
        return (int) $this->validated('page', 1);
    }
}
