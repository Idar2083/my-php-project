<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Cart\Domain\Models\CartItem;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\DatabaseMigrations;
use Illuminate\Support\Facades\DB;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class CartConcurrencyTest extends TestCase
{
    use DatabaseMigrations;

    private User $user;

    private Cart $cart;

    public function test_parallel_additions_to_same_item_do_not_cause_lost_update(): void
    {
        $product = $this->createProduct('Pepperoni');
        $item = $this->createCartItem($product, 1);

        [$first, $second] = $this->runConcurrently(
            $this->createProcess($product, 2),
            $this->createProcess($product, 3),
        );

        $this->assertTrue(
            $first->isSuccessful(),
            $first->getErrorOutput(),
        );

        $this->assertTrue(
            $second->isSuccessful(),
            $second->getErrorOutput(),
        );

        $this->assertSame(
            6,
            (int) $item->fresh()->quantity,
        );
    }

    public function test_parallel_additions_cannot_exceed_pizza_limit(): void
    {
        $product = $this->createProduct('Pepperoni');
        $item = $this->createCartItem($product, 9);

        [$first, $second] = $this->runConcurrently(
            $this->createProcess($product, 1),
            $this->createProcess($product, 1),
        );

        $successful = array_filter(
            [$first, $second],
            static fn (Process $process): bool => $process->isSuccessful(),
        );

        $failed = array_filter(
            [$first, $second],
            static fn (Process $process): bool => !$process->isSuccessful(),
        );

        $this->assertCount(1, $successful);
        $this->assertCount(1, $failed);

        $failedProcess = reset($failed);

        $this->assertInstanceOf(Process::class, $failedProcess);

        $this->assertStringContainsString(
            'ValidationException',
            $failedProcess->getErrorOutput(),
        );

        $this->assertSame(
            10,
            (int) $item->fresh()->quantity,
        );
    }

    public function test_two_first_additions_create_exactly_one_cart(): void
    {
        $this->cart->delete();
        $product = $this->createProduct('First cart');
        $first = $this->createProcess($product, 2);
        $second = $this->createProcess($product, 3);
        DB::beginTransaction();
        try {
            // Hold the FK parent: both workers must attempt INSERT before either
            // can commit. The loser then exercises the unique-violation savepoint.
            User::query()->lockForUpdate()->findOrFail($this->user->id);
            $first->start();
            $second->start();
            $deadline = microtime(true) + 10;
            do {
                $outputs = [$first->getOutput(), $second->getOutput()];
                $pids = array_map(static fn (string $output): int => (int) (json_decode(trim($output), true)['pid'] ?? 0), $outputs);
                DB::select('SELECT pg_stat_clear_snapshot()');
                $blocked = DB::select("SELECT pid FROM pg_stat_activity WHERE pid IN (?, ?) AND query ILIKE 'insert into \"carts\"%' AND cardinality(pg_blocking_pids(pid)) > 0", $pids);
                if (count($blocked) === 2) {
                    break;
                }
                usleep(20_000);
            } while (microtime(true) < $deadline && $first->isRunning() && $second->isRunning());
            $this->assertCount(2, $blocked, 'Both first-cart insertions must be blocked before releasing the parent.');
            DB::commit();
            $first->wait();
            $second->wait();
            $this->assertTrue($first->isSuccessful(), $first->getErrorOutput());
            $this->assertTrue($second->isSuccessful(), $second->getErrorOutput());
            $this->assertSame(1, Cart::query()->where('user_id', $this->user->id)->count());
            $this->assertSame(5, (int) CartItem::query()->where('product_id', $product->id)->value('quantity'));
        } finally {
            if (DB::transactionLevel() > 0) {
                DB::rollBack();
            }
            foreach ([$first, $second] as $process) {
                if ($process->isRunning()) {
                    $process->stop(0, 9);
                }
            }
        }
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->user = User::factory()->create();

        $this->cart = Cart::query()->create([
            'user_id' => $this->user->id,
        ]);
    }

    private function createProduct(string $name): Product
    {
        return Product::query()->create([
            'name' => $name,
            'category' => 'pizza',
            'description' => 'Concurrency test product',
            'price' => 500,
            'weight' => 0.55,
        ]);
    }

    private function createCartItem(
        Product $product,
        int $quantity,
    ): CartItem {
        return CartItem::query()->create([
            'cart_id' => $this->cart->id,
            'product_id' => $product->id,
            'quantity' => $quantity,
        ]);
    }

    private function createProcess(
        Product $product,
        int $quantity,
    ): Process {
        $process = new Process([
            PHP_BINARY,
            base_path('tests/Support/concurrency_cart_worker.php'),
            (string) $this->user->id,
            (string) $product->id,
            (string) $quantity,
        ]);
        $process->setInput(json_encode(['database' => config('database.connections.pgsql')], JSON_THROW_ON_ERROR));

        return $process;
    }

    /**
     * @return array{Process, Process}
     */
    private function runConcurrently(
        Process $first,
        Process $second,
    ): array {
        $first->start();
        $second->start();

        $first->wait();
        $second->wait();

        return [$first, $second];
    }
}
