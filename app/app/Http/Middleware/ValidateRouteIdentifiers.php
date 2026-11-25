<?php

declare(strict_types=1);

namespace App\Http\Middleware;

use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

final class ValidateRouteIdentifiers
{
    public function handle(Request $request, \Closure $next): Response
    {
        foreach (['id', 'itemId', 'orderId', 'report', 'userId'] as $parameter) {
            $value = $request->route($parameter);
            if ($value !== null && filter_var($value, FILTER_VALIDATE_INT, [
                'options' => ['min_range' => 1, 'max_range' => PHP_INT_MAX],
            ]) === false) {
                abort(Response::HTTP_NOT_FOUND);
            }
        }

        return $next($request);
    }
}
