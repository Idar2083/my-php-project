<?php

declare(strict_types=1);

use App\Http\Middleware\SetLocale;
use App\Modules\Auth\Presentation\Middleware\AdminMiddleware;
use App\Shared\Application\Exceptions\TranslatableException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Foundation\Application;
use Illuminate\Foundation\Configuration\Exceptions;
use Illuminate\Foundation\Configuration\Middleware;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

return Application::configure(basePath: dirname(__DIR__))
    ->withRouting(
        web: __DIR__ . '/../routes/web.php',
        api: __DIR__ . '/../routes/api.php',
        health: '/up',
    )
    ->withCommands([
        __DIR__ . '/../app/Modules/Report/Infrastructure/Console',
        __DIR__ . '/../app/Shared/Infrastructure/Outbox/Console',
    ])
    ->withSchedule(function (\Illuminate\Console\Scheduling\Schedule $schedule): void {
        require __DIR__ . '/../routes/console.php';
    })
    ->withMiddleware(function (Middleware $middleware): void {
        $middleware->api(
            prepend: [
                SetLocale::class,
            ],
        );

        $middleware->alias([
            'admin' => AdminMiddleware::class,
        ]);
    })
    ->withExceptions(function (Exceptions $exceptions): void {
        $exceptions->render(
            function (
                TranslatableException $exception,
                Request $request,
            ): Response {
                return response()->json(
                    [
                        'message' => __(
                            $exception->translationKey(),
                            $exception->parameters(),
                        ),
                    ],
                    $exception->statusCode(),
                );
            },
        );

        $exceptions->render(
            function (
                AuthenticationException $exception,
                Request $request,
            ): Response {
                return response()->json(
                    [
                        'message' => __('api.authorization.unauthenticated'),
                    ],
                    Response::HTTP_UNAUTHORIZED,
                );
            },
        );

        $exceptions->render(
            function (
                \Illuminate\Auth\Access\AuthorizationException $exception,
                Request $request,
            ): Response {
                return response()->json(
                    [
                        'message' => __('api.authorization.forbidden'),
                    ],
                    Response::HTTP_FORBIDDEN,
                );
            },
        );
    })
    ->create();
