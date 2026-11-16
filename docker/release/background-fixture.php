<?php

declare(strict_types=1);

// No application bootstrap, env files, database or network services.
use App\Modules\Auth\Domain\Events\UserRegisteredEvent;
use App\Shared\Application\Outbox\Contracts\OutboxEventRepository;
use App\Shared\Application\Outbox\OutboxProcessor;
use App\Shared\Infrastructure\Outbox\Console\ProcessOutbox;
use App\Shared\Infrastructure\Outbox\Models\OutboxEvent;
use Illuminate\Console\OutputStyle;
use Illuminate\Console\Scheduling\Event as ScheduledEvent;
use Illuminate\Console\Scheduling\EventMutex;
use Illuminate\Events\Dispatcher;
use Illuminate\Foundation\Application;
use Illuminate\Log\Context\Repository;
use Illuminate\Support\Facades\Facade;
use Symfony\Component\Console\Input\ArrayInput;
use Symfony\Component\Console\Output\ConsoleOutput;

require __DIR__ . '/../../app/vendor/autoload.php';
[$script, $mode, $directory] = $argv;
function record(string $message): void
{
    global $directory;
    file_put_contents($directory . '/events', $message . "\n", FILE_APPEND | LOCK_EX);
}
function gate(): void
{
    global $directory;
    record('READY ' . getmypid());
    $until = hrtime(true) + 20_000_000_000;
    while (!is_file($directory . '/finish')) {
        if (hrtime(true) > $until) {
            throw new RuntimeException('Fixture gate timed out.');
        }
        usleep(20_000);
    }
    record('FINISHED');
}
if ($mode === 'task') {
    gate();
    exit(0);
}
if (str_starts_with($mode, 'scheduler')) {
    require $argv[4] ?? __DIR__ . '/../php/scheduler.php';
    record('PARENT ' . getmypid());
    exit(runScheduler([PHP_BINARY, __FILE__, $mode === 'scheduler-failure' ? 'failure' : 'scheduled', $directory], (int) ($argv[3] ?? 60), $mode !== 'scheduler-idle'));
}
if ($mode === 'failure') {
    exit(7);
}
$app = new Application(dirname(__DIR__, 2) . '/app');
$events = new Dispatcher($app);
$app->instance('events', $events);
Facade::setFacadeApplication($app);
if ($mode === 'scheduled') {
    record('SCHEDULE_RUN ' . getmypid());
    $app->instance(Repository::class, new Repository($events));
    $mutex = new class () implements EventMutex {
        public function create(ScheduledEvent $event): bool
        {
            record('MUTEX_ACQUIRED');
            return true;
        }

        public function exists(ScheduledEvent $event): bool
        {
            return false;
        }

        public function forget(ScheduledEvent $event): void
        {
            record('MUTEX_RELEASED');
        }
    };
    $command = implode(' ', array_map('escapeshellarg', [PHP_BINARY, __FILE__, 'task', $directory]));
    $event = new ScheduledEvent($mutex, $command, 'UTC');
    $event->withoutOverlapping();
    $event->run($app);
    record('SCHEDULE_FINISHED');
    exit($event->exitCode ?? 1);
}
$repository = new class ($mode === 'outbox-idle') implements OutboxEventRepository {
    public int $claims = 0;

    public function __construct(private bool $empty)
    {
    }

    public function claimPending(int $limit): array
    {
        record('CLAIM ' . $limit);
        if ($this->empty) {
            record('IDLE');
            return [];
        }
        if ($this->claims++ > 0) {
            record('SECOND_CLAIM');
            return [];
        }
        return [new OutboxEvent(['event_type' => UserRegisteredEvent::TYPE, 'payload' => [
            'event_id' => 'fixture-event', 'user_id' => 1, 'name' => 'Fixture',
            'email' => 'fixture@example.invalid', 'occurred_at' => '2026-01-01T00:00:00Z',
        ]])];
    }

    public function markPublished(OutboxEvent $event): void
    {
        record('PUBLISHED');
    }

    public function markFailed(OutboxEvent $event, Throwable $exception): void
    {
        record('FAILED');
        throw $exception;
    }
};
$events->listen(UserRegisteredEvent::class, static function (): void {
    gate();
});
$command = new ProcessOutbox();
$input = new ArrayInput(['--worker' => $mode !== 'outbox-legacy'], $command->getDefinition());
$command->setInput($input);
$command->setOutput(new OutputStyle($input, new ConsoleOutput()));
record('PARENT ' . getmypid());
exit($command->handle(new OutboxProcessor($repository)));
