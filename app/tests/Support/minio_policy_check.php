<?php

declare(strict_types=1);

require __DIR__ . '/../../vendor/autoload.php';
$app = require __DIR__ . '/../../bootstrap/app.php';
$app->make(Illuminate\Contracts\Console\Kernel::class)->bootstrap();
if (!$app->environment('testing') || getenv('MINIO_POLICY_CHECK') !== '1') {
    throw new RuntimeException('Only run explicitly against isolated test services.');
}
$disk = Illuminate\Support\Facades\Storage::disk('s3');
if (!$disk->put('reports/security-check.jsonl', "{}\n") || !$disk->exists('reports/security-check.jsonl')) {
    throw new RuntimeException('Required write or head denied');
}
$stream = $disk->readStream('reports/security-check.jsonl');
if (!is_resource($stream) || stream_get_contents($stream) !== "{}\n") {
    throw new RuntimeException('Required read denied');
}
fclose($stream);
if ($disk->put('outside-prefix.txt', 'denied')) {
    throw new RuntimeException('Write outside report prefix permitted');
}
if ($disk->delete('reports/security-check.jsonl')) {
    throw new RuntimeException('Delete unexpectedly permitted');
}
echo "PASS: put/head/read reports; denied write outside prefix and delete\n";
$client = $disk->getClient();
foreach ([
    static fn () => $client->listBuckets(),
    static fn () => $client->listObjectsV2(['Bucket' => config('filesystems.disks.s3.bucket'), 'Prefix' => 'outside/']),
] as $operation) {
    try {
        $operation();
        throw new RuntimeException('Privileged storage operation unexpectedly permitted');
    } catch (Aws\S3\Exception\S3Exception $exception) {
        if ($exception->getStatusCode() !== 403) {
            throw $exception;
        }
    }
}
echo "PASS: bucket enumeration and listing outside prefix denied\n";
