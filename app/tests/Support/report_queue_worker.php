<?php

declare(strict_types=1);

use App\Modules\Report\Application\Contracts\ReportOrderItemReader;
use App\Modules\Report\Application\Contracts\ReportStorage;
use App\Modules\Report\Infrastructure\Storage\ReportStorage as S3ReportStorage;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Support\Facades\Artisan;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\LazyCollection;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

try {
    $input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);
    if (getenv('APP_ENV') !== 'testing' || $input['database']['driver'] !== 'pgsql') {
        throw new RuntimeException();
    }
    $app = require dirname(__DIR__, 2) . '/bootstrap/app.php';
    $app->make(Kernel::class)->bootstrap();
    config([
        'database.default' => 'pgsql',
        'database.connections.pgsql' => $input['database'],
        'queue.connections.rabbitmq' => $input['queue'],
        'rabbitmq' => $input['rabbitmq'],
        'filesystems.disks.s3' => $input['s3'],
        'cache.default' => 'array',
        'logging.default' => 'null',
    ]);
    DB::purge('pgsql');
    DB::statement("SET lock_timeout = '10s'");
    if ($input['mode'] === 'storage-down') {
        config([
            'filesystems.disks.s3.endpoint' => 'http://127.0.0.1:1',
            'filesystems.disks.s3.http' => ['connect_timeout' => 1, 'timeout' => 1],
            'filesystems.disks.s3.retries' => 0,
        ]);
    }
    if ($input['mode'] === 'crash') {
        $app->bind(ReportStorage::class, static fn () => new class () implements ReportStorage {
            private S3ReportStorage $storage;

            public function __construct()
            {
                $this->storage = new S3ReportStorage();
            }

            public function put(string $path, $stream): void
            {
                $this->storage->put($path, $stream);
                echo "uploaded\n";
                fflush(STDOUT);
                // The parent kills this real queue worker after the real S3 put.
                while (true) {
                    usleep(100_000);
                }
            }

            public function exists(string $path): bool
            {
                return $this->storage->exists($path);
            }

            public function readStream(string $path)
            {
                return $this->storage->readStream($path);
            }
        });
    }
    if ($input['mode'] === 'invalid-data') {
        $app->bind(ReportOrderItemReader::class, static fn () => new class () implements ReportOrderItemReader {
            public function between(DateTimeInterface $dateFrom, DateTimeInterface $dateTo): LazyCollection
            {
                return LazyCollection::make([(object) ['order_item_id' => 1, 'product_name' => "\xB1", 'price' => '1.00', 'quantity' => 1, 'user_id' => 1]]);
            }
        });
    }
    exit(Artisan::call('queue:work', ['connection' => 'rabbitmq', '--once' => true, '--sleep' => 0, '--timeout' => 0]));
} catch (Throwable $exception) {
    fwrite(STDERR, $exception::class . PHP_EOL);
    exit(1);
}
