<?php

declare(strict_types=1);

namespace App\Modules\Catalog\Presentation\Observers;

use App\Modules\Catalog\Application\Services\ProductService;
use App\Modules\Catalog\Domain\Models\Product;

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
