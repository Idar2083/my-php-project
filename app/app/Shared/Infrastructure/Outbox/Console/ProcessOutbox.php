<?php

declare(strict_types=1);

namespace App\Shared\Infrastructure\Outbox\Console;

use App\Shared\Application\Outbox\OutboxProcessor;
use Illuminate\Console\Command;

final class ProcessOutbox extends Command
{
    protected $signature = 'outbox:process';

    protected $description = 'Process pending outbox events.';

    public function handle(OutboxProcessor $processor): int
    {
        $processed = $processor->process();

        $this->info(
            sprintf(
                'Processed %d outbox event(s).',
                $processed,
            ),
        );

        return self::SUCCESS;
    }
}
