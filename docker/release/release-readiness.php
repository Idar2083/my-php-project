<?php

declare(strict_types=1);

use App\Modules\Report\Infrastructure\Messaging\RabbitMqConnection;
use Illuminate\Contracts\Console\Kernel;
use Illuminate\Filesystem\AwsS3V3Adapter;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Redis;
use Illuminate\Support\Facades\Storage;

// Sent over docker exec stdin into the new PHP container. Read-only dependency
// probes: no migrations, jobs, writes, bucket names or credentials in output.
try {
    $root = $argv[1] ?? throw new RuntimeException();
    require $root . '/vendor/autoload.php';
    $app = require $root . '/bootstrap/app.php';
    $app->make(Kernel::class)->bootstrap();
    DB::connection()->select('SELECT 1');
    if (Redis::connection()->ping() === false) {
        throw new RuntimeException();
    }
    $app->make(RabbitMqConnection::class)->connect()->close();
    $disk = Storage::disk('s3');
    if (!$disk instanceof AwsS3V3Adapter) {
        throw new RuntimeException();
    }
    $disk->getClient()->listObjectsV2(['Bucket' => config('filesystems.disks.s3.bucket'), 'MaxKeys' => 1]);
} catch (Throwable) {
    fwrite(STDERR, "Release dependency readiness failed.\n");
    exit(1);
}
