<?php

declare(strict_types=1);

namespace App\Shared\Infrastructure\Outbox\Console;

use App\Shared\Application\Outbox\OutboxProcessor;
use Illuminate\Console\Command;

final class ProcessOutbox extends Command
{
    protected $signature = 'outbox:process {--worker : Process events until a stop signal is received}';

    protected $description = 'Process pending outbox events.';

    private bool $stopping = false;

    public function handle(OutboxProcessor $processor): int
    {
        if ($this->option('worker')) {
            return $this->work($processor);
        }

        $processed = $processor->process();

        $this->info(
            sprintf(
                'Processed %d outbox event(s).',
                $processed,
            ),
        );

        return self::SUCCESS;
    }

    /** @phpstan-impure The signal handler can change this flag between reads. */
    private function isStopping(): bool
    {
        pcntl_signal_dispatch();

        return $this->stopping;
    }

    private function work(OutboxProcessor $processor): int
    {
        if (!extension_loaded('pcntl')) {
            $this->error('Outbox worker requires pcntl.');

            return self::FAILURE;
        }

        $this->stopping = false;
        pcntl_async_signals(true);
        pcntl_signal(SIGALRM, static function (): never {
            fwrite(STDERR, "Outbox shutdown deadline exceeded.\n");
            exit(124);
        });
        foreach ([SIGTERM, SIGQUIT, SIGINT] as $signal) {
            pcntl_signal($signal, function (): void {
                if (!$this->isStopping()) {
                    $this->stopping = true;
                    pcntl_alarm(60);
                }
            });
        }

        try {
            while (!$this->isStopping()) {
                // Claim only the current event: no unused batch leases on shutdown.
                for ($index = 0; $index < 100 && !$this->isStopping(); $index++) {
                    if ($processor->process(1) === 0) {
                        break;
                    }
                }
                $until = hrtime(true) + 60_000_000_000;
                while (!$this->isStopping() && hrtime(true) < $until) {
                    usleep(100_000);
                }
            }
        } finally {
            pcntl_alarm(0);
            foreach ([SIGTERM, SIGQUIT, SIGINT, SIGALRM] as $signal) {
                pcntl_signal($signal, SIG_DFL);
            }
        }

        return self::SUCCESS;
    }
}
