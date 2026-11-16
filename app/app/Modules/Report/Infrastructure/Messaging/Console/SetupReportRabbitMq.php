<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging\Console;

use App\Modules\Report\Infrastructure\Messaging\RabbitMqConnection;
use App\Modules\Report\Infrastructure\Messaging\RabbitMqTopology;
use Illuminate\Console\Command;

final class SetupReportRabbitMq extends Command
{
    protected $signature = 'reports:rabbitmq:setup';

    protected $description = 'Declare RabbitMQ topology for report generation';

    public function handle(
        RabbitMqConnection $connection,
        RabbitMqTopology $topology,
    ): int {
        $rabbitMqConnection = $connection->connect();

        try {
            $channel = $rabbitMqConnection->channel();

            $topology->declareGenerate($channel);
        } finally {
            if ($rabbitMqConnection->isConnected()) {
                $rabbitMqConnection->close();
            }
        }

        $this->info('RabbitMQ report generation topology is ready.');

        return self::SUCCESS;
    }
}
