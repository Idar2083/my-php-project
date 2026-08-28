<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Console;

use App\Modules\Report\Infrastructure\Messaging\RabbitMqConnection;
use App\Modules\Report\Infrastructure\Messaging\RabbitMqTopology;
use Illuminate\Console\Command;

final class SetupReportRabbitMq extends Command
{
    protected $signature = 'reports:rabbitmq-setup';

    protected $description = 'Declare RabbitMQ topology required for reports';

    public function handle(
        RabbitMqConnection $connection,
        RabbitMqTopology $topology,
    ): int {
        $rabbitMq = null;
        $channel = null;

        try {
            $rabbitMq = $connection->connect();
            $channel = $rabbitMq->channel();

            $topology->declare($channel);

            $this->info('Report RabbitMQ topology declared.');

            return self::SUCCESS;
        } catch (\Throwable $exception) {
            $this->error($exception->getMessage());

            report($exception);

            return self::FAILURE;
        } finally {
            if ($channel !== null && $channel->is_open()) {
                $channel->close();
            }

            if ($rabbitMq instanceof \PhpAmqpLib\Connection\AMQPStreamConnection && $rabbitMq->isConnected()) {
                $rabbitMq->close();
            }
        }
    }
}
