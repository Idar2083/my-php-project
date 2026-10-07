<?php

declare(strict_types=1);

use Illuminate\Contracts\Console\Kernel as ConsoleKernel;
use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;

require dirname(__DIR__, 2) . '/vendor/autoload.php';

try {
    // Runtime credentials/token travel through stdin, never argv, source or logs.
    $input = json_decode(stream_get_contents(STDIN), true, 512, JSON_THROW_ON_ERROR);

    if (getenv('APP_ENV') !== 'testing' || $input['database']['driver'] !== 'pgsql') {
        throw new RuntimeException('The worker requires the PostgreSQL test environment.');
    }

    /** @var Illuminate\Foundation\Application $app */
    $app = require dirname(__DIR__, 2) . '/bootstrap/app.php';
    $app->make(ConsoleKernel::class)->bootstrap();

    config([
        'database.default' => 'pgsql',
        'database.connections.pgsql' => $input['database'],
        'app.key' => $input['app_key'],
        'app.debug' => false,
        'jwt.secret' => $input['jwt_secret'],
        'cache.default' => 'array',
        'session.driver' => 'array',
        'queue.default' => 'sync',
    ]);

    DB::purge('pgsql');
    DB::statement("SET lock_timeout = '15s'");
    echo json_encode(['pid' => DB::selectOne('SELECT pg_backend_pid() AS pid')->pid], JSON_THROW_ON_ERROR) . PHP_EOL;
    fflush(STDOUT);

    $request = Request::create(
        '/api/admin/users/' . $input['user_id'] . '/role',
        'PATCH',
        server: [
            'HTTP_ACCEPT' => 'application/json',
            'CONTENT_TYPE' => 'application/json',
            'HTTP_AUTHORIZATION' => 'Bearer ' . $input['token'],
        ],
        content: json_encode(['role' => $input['role']], JSON_THROW_ON_ERROR),
    );

    /** @var Kernel $kernel */
    $kernel = $app->make(Kernel::class);
    $response = $kernel->handle($request);
    $body = json_decode($response->getContent(), true, 512, JSON_THROW_ON_ERROR);

    echo json_encode([
        'status' => $response->getStatusCode(),
        'role' => $body['data']['role'] ?? null,
    ], JSON_THROW_ON_ERROR) . PHP_EOL;
    $kernel->terminate($request, $response);
} catch (Throwable $exception) {
    // Do not print exception messages: database connection errors may include secrets.
    fwrite(STDERR, $exception::class . PHP_EOL);
    exit(1);
}
