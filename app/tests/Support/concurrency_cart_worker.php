<?php

declare(strict_types=1);

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Application\Services\CartService;
use Illuminate\Contracts\Console\Kernel;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

/** @var \Illuminate\Foundation\Application $app */
$app = require dirname(__DIR__, 2) . '/bootstrap/app.php';

/** @var Kernel $kernel */
$kernel = $app->make(Kernel::class);
$kernel->bootstrap();

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
