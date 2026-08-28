<?php

declare(strict_types=1);

namespace App\Providers;

use App\Modules\Catalog\Domain\Models\Product;
use App\Modules\Catalog\Presentation\Observers\ProductObserver;
use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\Contracts\ReportGenerationPublisher;
use App\Modules\Report\Application\Contracts\ReportOrderItemReader;
use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Infrastructure\Messaging\RabbitMqPublisher;
use App\Modules\Report\Infrastructure\Persistence\ReportOrderItemQuery;
use App\Modules\Report\Infrastructure\Storage\ReportStorage as InfrastructureReportStorage;
use Illuminate\Support\ServiceProvider;

class AppServiceProvider extends ServiceProvider
{
    /**
     * Register any application services.
     */
    public function register(): void
    {
        $this->app->bind(
            ReportOrderItemReader::class,
            ReportOrderItemQuery::class,
        );

        $this->app->bind(
            ReportStorage::class,
            InfrastructureReportStorage::class,
        );

        $this->app->bind(
            ReportCompletionPublisher::class,
            RabbitMqPublisher::class,
        );

        $this->app->bind(
            ReportGenerationPublisher::class,
            RabbitMqPublisher::class,
        );
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Product::observe(ProductObserver::class);
    }
}
