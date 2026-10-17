<?php

declare(strict_types=1);

namespace Tests\Feature\Order;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Cart\Domain\Models\CartItem;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Support\Facades\DB;
use Symfony\Component\Process\Process;
use Tests\TestCase;

final class OrderCheckoutConcurrencyTest extends TestCase
{
    use DatabaseMigrations;

    public function test_parallel_checkout_consumes_the_cart_exactly_once(): void
    {
        $buyer = User::factory()->create();
        $cart = Cart::factory()->for($buyer)->create();
        $product = Product::factory()->create(['price' => '12.50']);
        CartItem::factory()->for($cart)->for($product)->create(['quantity' => 2]);
        $processes = [];
        for ($i = 0; $i < 2; ++$i) {
            $process = new Process([PHP_BINARY, base_path('tests/Support/concurrency_order_worker.php'), (string) $buyer->id]);
            $process->setInput(json_encode(['database' => config('database.connections.pgsql')], JSON_THROW_ON_ERROR));
            $processes[] = $process;
        }
        DB::beginTransaction();
        try {
            Cart::query()->lockForUpdate()->findOrFail($cart->id);
            foreach ($processes as $process) {
                $process->start();
            }
            $deadline = microtime(true) + 10;
            do {
                $pids = array_map(static fn (Process $process): int => (int) (json_decode(strtok($process->getOutput(), "\n") ?: '{}', true)['pid'] ?? 0), $processes);
                DB::select('SELECT pg_stat_clear_snapshot()');
                $blocked = DB::select("SELECT pid FROM pg_stat_activity WHERE pid IN (?, ?) AND query ILIKE 'select%\"carts\"%for update%' AND cardinality(pg_blocking_pids(pid)) > 0", $pids);
                if (count($blocked) === 2) {
                    break;
                }
                usleep(20_000);
            } while (microtime(true) < $deadline && $processes[0]->isRunning() && $processes[1]->isRunning());
            self::assertCount(2, $blocked, 'Both checkout requests must be waiting for the same cart lock.');
            DB::commit();
            $results = [];
            foreach ($processes as $process) {
                $process->wait();
                self::assertTrue($process->isSuccessful(), $process->getErrorOutput());
                $lines = explode("\n", trim($process->getOutput()));
                $results[] = json_decode(end($lines), true, 512, JSON_THROW_ON_ERROR);
            }
            self::assertCount(1, array_filter($results, static fn (array $result): bool => isset($result['order_id'])));
            self::assertCount(1, array_filter($results, static fn (array $result): bool => ($result['errors'] ?? []) === ['cart']));
            $this->assertDatabaseCount('orders', 1);
            $this->assertDatabaseHas('orders', ['user_id' => $buyer->id, 'total_price' => '25.00']);
            $this->assertDatabaseCount('order_items', 1);
            $this->assertDatabaseCount('cart_items', 0);
        } finally {
            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            foreach ($processes as $process) {
                if ($process->isRunning()) {
                    $process->stop(0, 9);
                }
            }
        }
    }
}
