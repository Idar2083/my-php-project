<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Middleware;

use App\Modules\Auth\Domain\Enums\UserRole;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

class AdminMiddleware
{
    public function handle(Request $request, \Closure $next): Response
    {
        $user = auth('api')->user();

        if (! $user) {
            return response()->json([
                'message' => __('api.authorization.unauthenticated'),
            ], Response::HTTP_UNAUTHORIZED);
        }

        if ($user->role !== UserRole::ADMIN) {
            return response()->json([
                'message' => __('api.authorization.forbidden'),
            ], Response::HTTP_FORBIDDEN);
        }

        return $next($request);
    }
}
