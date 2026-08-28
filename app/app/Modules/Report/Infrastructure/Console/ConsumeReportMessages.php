<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Console;

use App\Modules\Report\Infrastructure\Messaging\RabbitMqConsumer;
use Illuminate\Console\Command;

final class ConsumeReportMessages extends Command
{
    protected $signature = 'reports:rabbitmq-consume';

    protected $description = 'Consume report generation messages from RabbitMQ';

    public function handle(RabbitMqConsumer $consumer): int
    {
        try {
            $this->info('Waiting for report messages...');

            $consumer->consume();

            return self::SUCCESS;
        } catch (\Throwable $exception) {
            $this->error($exception->getMessage());

            report($exception);

            return self::FAILURE;
        }
    }
}
