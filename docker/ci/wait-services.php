<?php

declare(strict_types=1);

use Aws\Exception\AwsException;
use Aws\S3\S3Client;
use PhpAmqpLib\Connection\AMQPStreamConnection;

require '/var/www/app/vendor/autoload.php';

$configuredTimeout = getenv('CI_SERVICE_WAIT_TIMEOUT');
$timeout = filter_var($configuredTimeout === false ? '120' : $configuredTimeout, FILTER_VALIDATE_INT);
if ($timeout === false || $timeout < 1 || $timeout > 600) {
    fwrite(STDERR, "CI_SERVICE_WAIT_TIMEOUT must be between 1 and 600 seconds.\n");
    exit(1);
}

function waitForService(string $name, int $timeout, callable $probe): void
{
    $deadline = hrtime(true) + $timeout * 1_000_000_000;
    do {
        try {
            $probe();
            echo $name . " is ready.\n";

            return;
        } catch (Throwable) {
            // Connection errors can contain credentials. Emit only a fixed service name.
        }

        if (hrtime(true) >= $deadline) {
            fwrite(STDERR, $name . " readiness timed out.\n");
            exit(1);
        }
        usleep(200_000);
    } while (true);
}

waitForService('PostgreSQL', $timeout, static function (): void {
    $connection = new PDO(
        sprintf(
            'pgsql:host=%s;port=%s;dbname=%s;connect_timeout=5',
            getenv('DB_HOST'),
            getenv('DB_PORT'),
            getenv('DB_DATABASE'),
        ),
        getenv('DB_USERNAME'),
        getenv('DB_PASSWORD'),
        [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION],
    );
    $connection->query('SELECT 1');
});

waitForService('RabbitMQ', $timeout, static function (): void {
    $connection = new AMQPStreamConnection(
        host: getenv('RABBITMQ_HOST'),
        port: (int) getenv('RABBITMQ_PORT'),
        user: getenv('RABBITMQ_USER'),
        password: getenv('RABBITMQ_PASSWORD'),
        vhost: getenv('RABBITMQ_VHOST'),
        connection_timeout: 5,
        read_write_timeout: 5,
        heartbeat: 0,
    );
    $connection->close();
});

waitForService('MinIO bucket', $timeout, static function (): void {
    $client = new S3Client([
        'version' => 'latest',
        'region' => getenv('AWS_DEFAULT_REGION'),
        'endpoint' => getenv('AWS_ENDPOINT'),
        'credentials' => [
            'key' => getenv('AWS_ACCESS_KEY_ID'),
            'secret' => getenv('AWS_SECRET_ACCESS_KEY'),
        ],
        'use_path_style_endpoint' => true,
        'http' => ['connect_timeout' => 5, 'timeout' => 5],
        'retries' => 0,
    ]);
    $bucket = ['Bucket' => getenv('AWS_BUCKET')];
    try {
        $client->headBucket($bucket);
    } catch (AwsException $exception) {
        if ($exception->getStatusCode() !== 404) {
            throw $exception;
        }
        $client->createBucket($bucket);
        $client->headBucket($bucket);
    }
});
