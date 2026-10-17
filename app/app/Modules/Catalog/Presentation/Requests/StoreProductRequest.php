<?php

declare(strict_types=1);

namespace App\Modules\Catalog\Presentation\Requests;

use App\Modules\Catalog\Domain\Models\Product;
use App\Modules\Catalog\Presentation\Rules\SupportedProductCategory;
use Illuminate\Foundation\Http\FormRequest;

class StoreProductRequest extends FormRequest
{
    public function authorize(): bool
    {
        return true;
    }

    /**
     * @return array<string, mixed>
     */
    public function rules(): array
    {
        return [
            'name' => ['required', 'string', 'max:255'],
            'price' => ['required', 'numeric', 'min:0', 'max:' . Product::MAX_PRICE, 'regex:/^\d+(?:\.\d{1,2})?$/D'],
            'category' => ['required', 'string', 'max:255', new SupportedProductCategory()],
            'description' => ['nullable', 'string', 'max:1000'],
            'weight' => ['required', 'numeric', 'gt:0'],
        ];
    }
}
