<?php

declare(strict_types=1);

namespace Tests\Integration\Auth;

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Support\Facades\DB;
use Symfony\Component\Process\Process;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class UserRoleConcurrencyTest extends TestCase
{
    use DatabaseMigrations;

    public function test_two_admins_cannot_demote_each_other(): void
    {
        $first = User::factory()->admin()->create();
        $second = User::factory()->admin()->create();

        [$firstResult, $secondResult] = $this->runConcurrently(
            $first->id,
            $this->worker($first, $second, UserRole::USER),
            $this->worker($second, $first, UserRole::USER),
        );

        $statuses = [$firstResult['status'], $secondResult['status']];
        sort($statuses);
        $this->assertSame([200, 403], $statuses);
        $this->assertSame(1, User::query()->where('role', UserRole::ADMIN)->count());
        $this->assertSame(
            $firstResult['status'] === 200 ? UserRole::USER : UserRole::ADMIN,
            $second->fresh()->role,
        );
        $this->assertSame(
            $secondResult['status'] === 200 ? UserRole::USER : UserRole::ADMIN,
            $first->fresh()->role,
        );
    }

    public function test_identical_assignments_to_one_target_are_idempotent(): void
    {
        $first = User::factory()->admin()->create();
        $second = User::factory()->admin()->create();
        $target = User::factory()->create();

        [$firstResult, $secondResult] = $this->runConcurrently(
            $target->id,
            $this->worker($first, $target, UserRole::ADMIN),
            $this->worker($second, $target, UserRole::ADMIN),
        );

        $this->assertSame(200, $firstResult['status']);
        $this->assertSame(200, $secondResult['status']);
        $this->assertSame('admin', $firstResult['role']);
        $this->assertSame('admin', $secondResult['role']);
        $this->assertSame(UserRole::ADMIN, $target->fresh()->role);
    }

    public function test_different_assignments_to_one_target_use_current_locked_state(): void
    {
        $first = User::factory()->admin()->create();
        $second = User::factory()->admin()->create();
        $target = User::factory()->create();

        [$firstResult, $secondResult] = $this->runConcurrently(
            $target->id,
            $this->worker($first, $target, UserRole::ADMIN),
            $this->worker($second, $target, UserRole::USER),
        );

        $this->assertSame(200, $firstResult['status']);
        $this->assertSame(200, $secondResult['status']);
        $this->assertSame('admin', $firstResult['role']);
        $this->assertSame('user', $secondResult['role']);
        // The barrier queues promotion first and demotion second on the target row.
        $this->assertSame(UserRole::USER, $target->fresh()->role);
        $this->assertSame(UserRole::ADMIN, $first->fresh()->role);
        $this->assertSame(UserRole::ADMIN, $second->fresh()->role);
    }

    public function test_unrelated_participants_do_not_wait_on_another_pair(): void
    {
        $lockedAdmin = User::factory()->admin()->create();
        $actor = User::factory()->admin()->create();
        $target = User::factory()->create();
        $worker = $this->worker($actor, $target, UserRole::ADMIN);

        DB::beginTransaction();

        try {
            User::query()->lockForUpdate()->findOrFail($lockedAdmin->id);
            $worker->start();
            $worker->wait();
            $this->assertSame(200, $this->workerResult($worker)['status']);
        } finally {
            if ($worker->isRunning()) {
                $worker->stop();
            }

            DB::rollBack();
        }

        $this->assertSame(UserRole::ADMIN, $target->fresh()->role);
    }

    public function test_conflict_rolls_back_row_locks_before_next_process(): void
    {
        $actor = User::factory()->admin()->create();
        $target = User::factory()->create();
        $conflict = $this->worker($actor, $actor, UserRole::USER);
        $conflict->run();
        $this->assertSame(409, $this->workerResult($conflict)['status']);

        $promotion = $this->worker($actor, $target, UserRole::ADMIN);
        $promotion->run();
        $this->assertSame(200, $this->workerResult($promotion)['status']);
        $this->assertSame(UserRole::ADMIN, $target->fresh()->role);
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->assertTrue(app()->environment('testing'));
        $this->assertSame('pgsql', DB::connection()->getDriverName());
        $this->assertSame($_SERVER['DB_DATABASE'], DB::connection()->getDatabaseName());
        $this->assertSame('read committed', DB::selectOne('SHOW transaction_isolation')->transaction_isolation);
    }

    private function worker(User $actor, User $target, UserRole $role): Process
    {
        $process = new Process(
            [PHP_BINARY, base_path('tests/Support/concurrency_user_role_worker.php')],
            base_path(),
            ['APP_ENV' => 'testing', 'APP_DEBUG' => 'false'],
        );
        $process->setTimeout(30);
        $process->setInput(json_encode([
            'database' => config('database.connections.' . DB::getDefaultConnection()),
            'app_key' => config('app.key'),
            'jwt_secret' => config('jwt.secret'),
            'token' => JWTAuth::fromUser($actor),
            'user_id' => $target->id,
            'role' => $role->value,
        ], JSON_THROW_ON_ERROR));

        return $process;
    }

    /** @return array{array{status: int, role: ?string}, array{status: int, role: ?string}} */
    private function runConcurrently(int $lockedId, Process $first, Process $second): array
    {
        DB::beginTransaction();

        try {
            User::query()->lockForUpdate()->findOrFail($lockedId);
            $first->start();
            $this->waitUntilBlocked($first);
            $second->start();
            $this->waitUntilBlocked($first, $second);
            DB::commit();
            $first->wait();
            $second->wait();

            return [$this->workerResult($first), $this->workerResult($second)];
        } finally {
            // Stop workers before releasing a failed barrier to avoid writes during teardown.
            foreach ([$first, $second] as $process) {
                if ($process->isRunning()) {
                    $process->stop();
                }
            }

            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
        }
    }

    private function waitUntilBlocked(Process ...$processes): void
    {
        $deadline = microtime(true) + 10;

        do {
            $blocked = 0;

            foreach ($processes as $process) {
                $process->checkTimeout();
                $output = $process->getOutput();

                if (! str_contains($output, PHP_EOL)) {
                    $this->assertTrue($process->isRunning(), 'Worker stopped before connecting: ' . $process->getErrorOutput());
                    continue;
                }

                $connection = json_decode(explode(PHP_EOL, $output)[0], true, 512, JSON_THROW_ON_ERROR);
                // Clear PostgreSQL's cached activity snapshot in this open barrier transaction.
                DB::select('SELECT pg_stat_clear_snapshot()');
                $state = DB::selectOne(
                    "SELECT count(*) AS blocked FROM pg_stat_activity WHERE pid = ? AND wait_event_type = 'Lock' AND query ILIKE '%for update%' AND cardinality(pg_blocking_pids(pid)) > 0",
                    [$connection['pid']],
                );
                $blocked += (int) $state->blocked;
            }

            if ($blocked === count($processes)) {
                return;
            }

            usleep(10_000);
        } while (microtime(true) < $deadline);

        $this->fail('HTTP workers must reach participant row locks before releasing the barrier.');
    }

    /** @return array{status: int, role: ?string} */
    private function workerResult(Process $process): array
    {
        $this->assertTrue($process->isSuccessful(), $process->getErrorOutput());
        $lines = explode(PHP_EOL, trim($process->getOutput()));
        $this->assertCount(2, $lines);

        return json_decode($lines[1], true, 512, JSON_THROW_ON_ERROR);
    }
}
