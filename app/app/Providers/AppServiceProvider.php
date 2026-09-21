<?php

declare(strict_types=1);

namespace App\Providers;

use App\Modules\Auth\Application\Contracts\WelcomeEmailSender;
use App\Modules\Auth\Application\Listeners\SendWelcomeEmail;
use App\Modules\Auth\Domain\Events\UserRegisteredEvent;
use App\Modules\Auth\Infrastructure\Mail\WelcomeEmailStub;
use App\Modules\Catalog\Domain\Models\Product;
use App\Modules\Catalog\Presentation\Observers\ProductObserver;
use App\Modules\Report\Application\Contracts\ReportCompletionPublisher;
use App\Modules\Report\Application\Contracts\ReportOrderItemReader;
use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Infrastructure\Messaging\RabbitMqPublisher;
use App\Modules\Report\Infrastructure\Persistence\ReportOrderItemQuery;
use App\Modules\Report\Infrastructure\Storage\ReportStorage as InfrastructureReportStorage;
use App\Shared\Application\Outbox\Contracts\OutboxEventRepository;
use App\Shared\Application\Outbox\Contracts\OutboxRepository;
use App\Shared\Infrastructure\Outbox\Repositories\DatabaseOutboxEventRepository;
use App\Shared\Infrastructure\Outbox\Repositories\DatabaseOutboxRepository;
use Illuminate\Support\Facades\Event;
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
            OutboxRepository::class,
            DatabaseOutboxRepository::class,
        );

        $this->app->bind(
            OutboxEventRepository::class,
            DatabaseOutboxEventRepository::class,
        );

        $this->app->bind(
            WelcomeEmailSender::class,
            WelcomeEmailStub::class,
        );
    }

    /**
     * Bootstrap any application services.
     */
    public function boot(): void
    {
        Product::observe(ProductObserver::class);

        Event::listen(
            UserRegisteredEvent::class,
            SendWelcomeEmail::class,
        );
    }
}
