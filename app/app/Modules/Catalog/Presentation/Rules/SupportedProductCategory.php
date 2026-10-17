<?php

declare(strict_types=1);

namespace App\Modules\Catalog\Presentation\Rules;

use App\Modules\Catalog\Domain\Enums\ProductCategory;
use Illuminate\Contracts\Validation\ValidationRule;

final class SupportedProductCategory implements ValidationRule
{
    public function validate(string $attribute, mixed $value, \Closure $fail): void
    {
        if (!is_string($value) || !ProductCategory::fromLabel($value) instanceof ProductCategory) {
            $fail('validation.in')->translate();
        }
    }
}
