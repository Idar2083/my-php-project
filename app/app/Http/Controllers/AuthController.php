<?php

namespace App\Http\Controllers;

use App\Http\Requests\LoginRequest;
use App\Http\Requests\RegisterRequest;
use App\Http\Controllers\Models\User;
use Tymon\JWTAuth\Facades\JWTAuth;
use Symfony\Component\HttpFoundation\Response;

class AuthController extends Controller
{
    public function register(RegisterRequest $request): Response
    {
        $user = User::create($request->validated());

        $token = JWTAuth::fromUser($user);

        return response()->json([
            'token' => $token,
            'token_type' => 'bearer',
        ]);
    }

    public function login(LoginRequest $request): Response
    {
        $credentials = $request->validated();

        $token = auth('api')->attempt($credentials);

        if ($token === false) {
            return response()->json([
                'message' => 'Invalid credentials',
            ], Response::HTTP_UNAUTHORIZED);
        }

        return response()->json([
            'token' => $token,
            'token_type' => 'bearer',
        ]);
    }

    public function me(): Response
    {
        return response()->json(auth('api')->user());
    }

    public function logout(): Response
    {
        auth('api')->logout();

        return response()->json([
            'message' => 'Successfully logged out',
        ]);
    }
}
