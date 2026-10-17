<?php

declare(strict_types=1);

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Application\Services\CartService;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;

$projectRoot = dirname(__DIR__, 2);

require $projectRoot . '/vendor/autoload.php';

$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
if (getenv('APP_ENV') !== 'testing' || ($input['database']['driver'] ?? null) !== 'pgsql') {
    exit(1);
}

/** @var \Illuminate\Foundation\Application $app */
$app = require $projectRoot . '/bootstrap/app.php';

/** @var Kernel $kernel */
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();

config(['database.default' => 'pgsql', 'database.connections.pgsql' => $input['database']]);
DB::purge('pgsql');
DB::statement("SET lock_timeout = '15s'");
echo json_encode(['pid' => DB::selectOne('SELECT pg_backend_pid() AS pid')->pid], JSON_THROW_ON_ERROR) . PHP_EOL;
fflush(STDOUT);

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
        $exception::class,
    );

    exit(1);
}
