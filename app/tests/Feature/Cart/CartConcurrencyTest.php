<?php

declare(strict_types=1);

namespace Tests\Feature;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Cart\Domain\Models\CartItem;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Support\Facades\Artisan;
use Symfony\Component\Process\Process;
use Tests\TestCase;

class CartConcurrencyTest extends TestCase
{
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

    protected function setUp(): void
    {
        parent::setUp();

        config([
            'database.default' => 'pgsql',
            'database.connections.pgsql.host' => 'postgres',
            'database.connections.pgsql.port' => 5_432,
            'database.connections.pgsql.database' => 'pizza_app_test',
            'database.connections.pgsql.username' => 'pizza_db_user',
            'database.connections.pgsql.password' => (string) env('DB_PASSWORD'),
        ]);

        Artisan::call('migrate:fresh', [
            '--database' => 'pgsql',
            '--force' => true,
        ]);

        $this->user = User::factory()->create();

        $this->cart = Cart::factory()
            ->for($this->user)
            ->create();
    }

    private function createProduct(string $name): Product
    {
        return Product::factory()->create([
            'name' => $name,
        ]);
    }

    private function createCartItem(
        Product $product,
        int $quantity,
    ): CartItem {
        return CartItem::factory()
            ->for($this->cart)
            ->for($product)
            ->create([
                'quantity' => $quantity,
            ]);
    }

    private function createProcess(
        Product $product,
        int $quantity,
    ): Process {
        return new Process([
            PHP_BINARY,
            base_path('tests/Support/concurrency_cart_worker.php'),
            (string) $this->user->id,
            (string) $product->id,
            (string) $quantity,
        ]);
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
