<?php

declare(strict_types=1);

namespace App\Modules\Report\Presentation\Requests;

use Carbon\CarbonImmutable;
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
                'date_format:Y-m-d',
            ],
            'date_to' => [
                'required',
                'date_format:Y-m-d',
                'after_or_equal:date_from',
            ],
        ];
    }

    public function normalizedDateFrom(): CarbonImmutable
    {
        return CarbonImmutable::createFromFormat(
            'Y-m-d',
            (string) $this->string('date_from'),
        )->startOfDay();
    }

    public function normalizedDateTo(): CarbonImmutable
    {
        return CarbonImmutable::createFromFormat(
            'Y-m-d',
            (string) $this->string('date_to'),
        )->startOfDay();
    }
}
