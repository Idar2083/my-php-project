<?php

declare(strict_types=1);

namespace App\Providers;

use App\Modules\Catalog\Domain\Models\Product;
use App\Modules\Catalog\Presentation\Observers\ProductObserver;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        //
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Product::observe(ProductObserver::class);
    }
}
