<?php

declare(strict_types=1);

// Standalone fixture: vendor autoload only, never Laravel bootstrap or env files.
use Illuminate\Container\Container;
use Illuminate\Contracts\Debug\ExceptionHandler;
use Illuminate\Events\Dispatcher;
use Illuminate\Queue\Events\WorkerInterrupted;
use Illuminate\Queue\Events\WorkerStopping;
use Illuminate\Queue\Jobs\SyncJob;
use Illuminate\Queue\QueueManager;
use Illuminate\Queue\SyncQueue;
use Illuminate\Queue\Worker;
use Illuminate\Queue\WorkerOptions;

require $argv[1];

if (!extension_loaded('pcntl') || !function_exists('pcntl_async_signals')) {
    fwrite(STDERR, "pcntl is required for the queue signal test.\n");
    exit(1);
}

$container = new Container();
$events = new Dispatcher($container);
$queue = new class () extends SyncQueue {
    public array $jobs = [];
    public int $pops = 0;

    public function pop($queue = null)
    {
        $this->pops++;

        return array_shift($this->jobs);
    }
};
$queue->setConnectionName('isolated');

for ($index = 1; $index <= 2; $index++) {
    $queue->jobs[] = new class ($container, json_encode(['job' => 'ControlledFixture', 'data' => [], 'id' => $index]), 'isolated', 'isolated') extends SyncJob {
        public function fire(): void
        {
            $index = $this->payload()['id'];
            if ($index !== 1) {
                echo "SECOND_STARTED\n";
                $this->delete();

                return;
            }

            echo 'READY pid=' . getmypid() . "\n";
            stream_set_blocking(STDIN, false);
            $deadline = hrtime(true) + 15_000_000_000;
            $input = '';
            while (!str_contains($input, "finish\n")) {
                $chunk = fread(STDIN, 1024);
                if ($chunk !== false) {
                    $input .= $chunk;
                }
                if (hrtime(true) > $deadline) {
                    throw new RuntimeException('Fixture completion gate timed out.');
                }
                usleep(10_000);
            }
            echo "FINISHED\n";
            $this->delete();
            echo "ACKNOWLEDGED\n";
        }
    };
}

$manager = new class ($container, $queue) extends QueueManager {
    public function __construct(Container $container, private readonly SyncQueue $fixture)
    {
        parent::__construct($container);
    }

    public function connection($name = null)
    {
        return $this->fixture;
    }
};
$exceptions = new class () implements ExceptionHandler {
    public function report(Throwable $e): void { throw $e; }
    public function shouldReport(Throwable $e): bool { return true; }
    public function render($request, Throwable $e): never { throw $e; }
    public function renderForConsole($output, Throwable $e): never { throw $e; }
};
$events->listen(WorkerInterrupted::class, static function (WorkerInterrupted $event): void {
    echo 'SIGNAL ' . $event->signal . "\n";
});
$events->listen(WorkerStopping::class, static function (WorkerStopping $event): void {
    echo 'STOPPED ' . $event->reason->value . "\n";
});

$worker = new Worker($manager, $events, $exceptions, static fn (): bool => false);
$status = $worker->daemon('isolated', 'isolated', new WorkerOptions(timeout: 20, sleep: 0, maxJobs: 2, maxTime: 20));
if ($status !== 0 || $queue->pops !== 1 || count($queue->jobs) !== 1) {
    fwrite(STDERR, "Worker did not stop after exactly one completed fixture job.\n");
    exit(1);
}
echo "RESULT remaining=1 pops=1\n";
exit($status);
