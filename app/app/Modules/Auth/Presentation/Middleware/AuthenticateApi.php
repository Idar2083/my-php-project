<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Middleware;

use Illuminate\Auth\Middleware\Authenticate;

final class AuthenticateApi extends Authenticate
{
    public function handle($request, \Closure $next, ...$guards)
    {
        return parent::handle($request, $next, $request->hasSession() ? 'web' : 'api');
    }
}
