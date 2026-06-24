<?php

namespace App\Http\Middleware;

use Closure;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;
use App\Http\Controllers\Models\User;

class AdminMiddleware
{

    public function handle(Request $request, Closure $next): Response
    {
        $user = auth('api')->user();

        if (!$user) {
            return response()->json([
                'message' => 'Unauthenticated.',
            ], Response::HTTP_UNAUTHORIZED);
        }

        if ($user->role !== User::ROLE_ADMIN) {
            return response()->json([
                'message' => 'Forbidden.',
            ], Response::HTTP_FORBIDDEN);
        }

        return $next($request);
    }
}
