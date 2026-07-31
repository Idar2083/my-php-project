<?php

declare(strict_types=1);

namespace App\Observers;

use App\Http\Controllers\Models\Product;
use App\Services\ProductService;

class ProductObserver
{
    public function __construct(
        private ProductService $productService,
    ) {
    }

    public function created(Product $product): void
    {
        $this->productService->bumpCacheVersion();
    }

    public function updated(Product $product): void
    {
        $this->productService->bumpCacheVersion();
    }

    public function deleted(Product $product): void
    {
        $this->productService->bumpCacheVersion();
    }
}
