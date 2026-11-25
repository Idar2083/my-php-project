<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Controllers;

use App\Http\Controllers\Controller;
use App\Modules\Auth\Application\Handlers\RegisterUserHandler;
use App\Modules\Auth\Presentation\Resources\Requests\LoginRequest;
use App\Modules\Auth\Presentation\Resources\Requests\RegisterRequest;
use Illuminate\Http\Request;
use Symfony\Component\HttpFoundation\Response;

final class AuthController extends Controller
{
    public function __construct(
        private readonly RegisterUserHandler $registerUserHandler,
    ) {
    }

    public function csrfCookie(Request $request): Response
    {
        abort_unless($request->hasSession(), Response::HTTP_FORBIDDEN);

        return response()->noContent()->header('Cache-Control', 'no-store');
    }

    public function register(RegisterRequest $request): Response
    {
        $data = $request->validated();

        $user = $this->registerUserHandler->handle(
            name: $data['name'],
            email: $data['email'],
            password: $data['password'],
        );

        if ($request->hasSession()) {
            auth('web')->login($user->refresh());

            return $this->me($request);
        }

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

        if ($request->hasSession()) {
            if (!auth('web')->attempt($credentials)) {
                return response()->json([
                    'message' => __('api.auth.invalid_credentials'),
                ], Response::HTTP_UNAUTHORIZED);
            }

            return $this->me($request);
        }

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

    public function me(Request $request): Response
    {
        if ($request->hasSession()) {
            return response()->json($request->user('web'))->header('Cache-Control', 'no-store');
        }

        return response()->json($request->user());
    }

    public function logout(Request $request): Response
    {
        if ($request->hasSession()) {
            auth('web')->logout();
            $request->session()->invalidate();
            $request->session()->regenerateToken();
        } else {
            auth('api')->logout();
        }

        return response()->json([
            'message' => __('api.auth.logged_out'),
        ]);
    }
}
