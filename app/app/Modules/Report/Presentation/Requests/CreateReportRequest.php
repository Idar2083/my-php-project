<?php

declare(strict_types=1);

namespace App\Modules\Report\Presentation\Requests;

use Illuminate\Foundation\Http\FormRequest;

final class CreateReportRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, array<int, string>>
     */
    public function rules(): array
    {
        return [
            'date_from' => [
                'required',
                'date',
            ],
            'date_to' => [
                'required',
                'date',
                'after_or_equal:date_from',
            ],
        ];
    }
}
