<?php

declare(strict_types=1);

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Order\Application\Services\OrderService;
use App\Modules\Order\Domain\Models\DTO\AddressDto;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\ValidationException;

require dirname(__DIR__, 2) . '/vendor/autoload.php';
$input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
if (getenv('APP_ENV') !== 'testing' || ($input['database']['driver'] ?? null) !== 'pgsql') {
    exit(1);
}
$app = require dirname(__DIR__, 2) . '/bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
config(['database.default' => 'pgsql', 'database.connections.pgsql' => $input['database']]);
DB::purge('pgsql');
DB::statement("SET lock_timeout = '15s'");
echo json_encode(['pid' => DB::selectOne('SELECT pg_backend_pid() AS pid')->pid], JSON_THROW_ON_ERROR) . PHP_EOL;
fflush(STDOUT);
try {
    $order = app(OrderService::class)->create(
        User::query()->findOrFail((int) $argv[1]),
        AddressDto::fromArray([
            'region' => 'Region', 'city' => 'City', 'street' => 'Street', 'house' => '1',
            'postal_code' => '123456', 'delivery_method' => 'delivery',
        ]),
    );
    echo json_encode(['order_id' => $order->id], JSON_THROW_ON_ERROR) . PHP_EOL;
} catch (ValidationException $exception) {
    echo json_encode(['errors' => array_keys($exception->errors())], JSON_THROW_ON_ERROR) . PHP_EOL;
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class);
    exit(1);
}
