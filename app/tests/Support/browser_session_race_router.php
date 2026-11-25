<?php

declare(strict_types=1);

use Illuminate\Contracts\Http\Kernel;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use Symfony\Component\HttpFoundation\Response;

final class SessionFingerprint
{
    public function handle(Request $request, Closure $next): Response
    {
        $response = $next($request);
        if ($request->hasSession()) {
            $response->headers->set('X-Test-Session-Fingerprint', hash('sha256', $request->session()->getId()));
        }

        return $response;
    }
}

require __DIR__ . '/../../vendor/autoload.php';
$app = require __DIR__ . '/../../bootstrap/app.php';
$app->booted(static function (): void {
    $directory = getenv('AUTH_RACE_BARRIER_DIR');
    if (!app()->environment('testing') || config('database.default') !== 'pgsql'
        || config('database.connections.pgsql.database') !== 'pizza_ui_test'
        || ($_SERVER['REMOTE_ADDR'] ?? null) !== '127.0.0.1'
        || !is_string($directory) || !is_dir($directory)) {
        throw new RuntimeException('An isolated browser session test environment is required.');
    }

    app(Kernel::class)->prependMiddleware(SessionFingerprint::class);

    Route::middleware(['api', 'auth.api'])->get('/api/__browser-session-race/{barrier}', static function (Request $request, string $barrier) use ($directory): Response {
        if (!touch($directory . '/' . $barrier . '.started')) {
            throw new RuntimeException('Could not signal that the request loaded the session.');
        }

        $release = $directory . '/' . $barrier . '.release';
        $deadline = microtime(true) + 25;
        do {
            clearstatcache(true, $release);
            if (is_file($release)) {
                $request->session()->put('race-test-marker', true);

                return response()->noContent();
            }

            usleep(25_000);
        } while (microtime(true) < $deadline);

        throw new RuntimeException('Timed out waiting for the concurrent request.');
    })->whereUuid('barrier');
});
$app->handleRequest(Request::capture());
