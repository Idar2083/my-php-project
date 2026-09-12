<?php

declare(strict_types=1);

namespace App\Modules\Order\Presentation\Requests;

use App\Http\Requests\ApiRequest;
use App\Modules\Order\Domain\Enums\OrderStatus;
use Illuminate\Validation\Rules\Enum;

class UpdateOrderStatusRequest extends ApiRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, mixed>>
     */
    public function rules(): array
    {
        return [
            'status' => [
                'required',
                new Enum(OrderStatus::class),
            ],
        ];
    }

    /**
     * Возвращает валидированный статус сразу в виде объекта Enum
     */
    public function getStatus(): OrderStatus
    {
        return $this->validated('status');
    }
}
