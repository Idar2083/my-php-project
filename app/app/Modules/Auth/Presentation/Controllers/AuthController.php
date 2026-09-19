<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Controllers;

use App\Http\Controllers\Controller;
use App\Modules\Auth\Application\Handlers\RegisterUserHandler;
use App\Modules\Auth\Presentation\Requests\LoginRequest;
use App\Modules\Auth\Presentation\Requests\RegisterRequest;
use Symfony\Component\HttpFoundation\Response;

final class AuthController extends Controller
{
    public function __construct(
        private readonly RegisterUserHandler $registerUserHandler,
    ) {
    }

    public function register(RegisterRequest $request): Response
    {
        $data = $request->validated();

        $user = $this->registerUserHandler->handle(
            name: $data['name'],
            email: $data['email'],
            password: $data['password'],
        );

        /** @var \Tymon\JWTAuth\JWTAuth $jwtAuth */
        $jwtAuth = app('tymon.jwt.auth');

        $token = $jwtAuth->fromUser($user);

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
                'message' => __('api.auth.invalid_credentials'),
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
            'message' => __('api.auth.logged_out'),
        ]);
    }
}
