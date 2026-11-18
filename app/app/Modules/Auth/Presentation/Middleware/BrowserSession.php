<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Middleware;

use Laravel\Sanctum\Http\Middleware\EnsureFrontendRequestsAreStateful;

final class BrowserSession extends EnsureFrontendRequestsAreStateful
{
    public function handle($request, $next)
    {
        // Keep existing API clients stateless, even when they send an Origin header.
        if ($request->header('X-Pizza-Client') !== 'spa' || $request->bearerToken() !== null) {
            return $next($request);
        }

        abort_unless(self::fromFrontend($request), 403);

        return parent::handle($request, $next);
    }
}
