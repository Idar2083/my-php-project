<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

final class SetLocale
{
    private const array SUPPORTED_LOCALES = [
        'en',
        'ru',
    ];

    public function handle(
        Request $request,
        \Closure $next,
    ): Response {
        app()->setLocale(
            $this->resolveLocale($request),
        );

        return $next($request);
    }

    private function resolveLocale(Request $request): string
    {
        foreach ($request->getLanguages() as $language) {
            $locale = strtolower(
                explode('-', $language, 2)[0],
            );

            if (in_array($locale, self::SUPPORTED_LOCALES, true)) {
                return $locale;
            }
        }

        return (string) config(
            'app.fallback_locale',
            'en',
        );
    }
}
