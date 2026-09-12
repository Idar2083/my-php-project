<?php

declare(strict_types=1);

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Application\Services\CartService;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

$projectRoot = dirname(__DIR__, 2);

require $projectRoot . '/vendor/autoload.php';

/** @var \Illuminate\Foundation\Application $app */
$app = require $projectRoot . '/bootstrap/app.php';

/** @var Kernel $kernel */
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();

config([
    'database.default' => 'pgsql',
    'database.connections.pgsql.host' => 'postgres',
    'database.connections.pgsql.port' => 5_432,
    'database.connections.pgsql.database' => 'pizza_app_test',
    'database.connections.pgsql.username' => 'pizza_db_user',
]);

DB::purge('pgsql');
DB::setDefaultConnection('pgsql');

try {
    $user = User::query()->findOrFail((int) $argv[1]);

    /** @var CartService $cartService */
    $cartService = $app->make(CartService::class);

    $cartService->addItem(
        $user,
        (int) $argv[2],
        (int) $argv[3],
    );

    exit(0);
} catch (Throwable $exception) {
    fwrite(
        STDERR,
        $exception::class . ': ' . $exception->getMessage(),
    );

    exit(1);
}
