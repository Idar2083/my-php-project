<?php

declare(strict_types=1);

// Only the restored container's loopback namespace is reachable. Credentials
// are disposable and supplied via env, never loaded from Laravel or .env.
require $argv[1];

try {
    $s3 = new Aws\S3\S3Client([
        'version' => 'latest',
        'region' => 'us-east-1',
        'endpoint' => 'http://127.0.0.1:9000',
        'use_path_style_endpoint' => true,
        'credentials' => [
            'key' => getenv('MINIO_ROOT_USER'),
            'secret' => getenv('MINIO_ROOT_PASSWORD'),
        ],
        'retries' => 0,
        'http' => ['connect_timeout' => 2, 'timeout' => 20],
    ]);
    $buckets = 0;
    $objects = 0;
    $bytes = 0;
    $hash = hash_init('sha256');
    foreach ($s3->listBuckets()['Buckets'] ?? [] as $bucket) {
        $buckets++;
        // Includes retained versions, not just the current object listing.
        foreach ($s3->getPaginator('ListObjectVersions', ['Bucket' => $bucket['Name']]) as $page) {
            foreach ($page['Versions'] ?? [] as $object) {
                $result = $s3->getObject([
                    'Bucket' => $bucket['Name'],
                    'Key' => $object['Key'],
                    'VersionId' => $object['VersionId'],
                    '@http' => ['stream' => true],
                ]);
                $body = $result['Body'];
                $read = 0;
                try {
                    while (true) {
                        $chunk = $body->read(1_024 * 1_024);
                        if ($chunk === '') {
                            if ($body->eof()) {
                                break;
                            }
                            throw new RuntimeException();
                        }
                        hash_update($hash, $chunk);
                        $read += strlen($chunk);
                    }
                } finally {
                    $body->close();
                }
                if ($read !== (int) $object['Size'] || $read !== (int) $result['ContentLength']) {
                    throw new RuntimeException();
                }
                $bytes += $read;
                $objects++;
            }
        }
    }
    // Aggregate counts/hash only; never disclose bucket names, keys or data.
    echo json_encode(['buckets' => $buckets, 'versions' => $objects, 'bytes' => $bytes, 'content_sha256' => hash_final($hash)], JSON_THROW_ON_ERROR) . "\n";
} catch (Throwable) {
    fwrite(STDERR, "Restored MinIO S3 verification failed.\n");
    exit(1);
}
