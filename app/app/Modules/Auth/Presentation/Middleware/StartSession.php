<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Middleware;

use App\Modules\Auth\Infrastructure\Session\DatabaseSessionHandler;
use Illuminate\Http\Request;
use Illuminate\Session\Middleware\StartSession as LaravelStartSession;
use Symfony\Component\HttpFoundation\Response;

final class StartSession extends LaravelStartSession
{
    public function handle($request, \Closure $next)
    {
        $response = parent::handle($request, $next);

        if ($request->hasSession()) {
            $session = $request->session();
            $handler = $session->getHandler();
            if ($handler instanceof DatabaseSessionHandler && !$handler->saved()) {
                $config = $this->manager->getSessionConfig();

                // A stale response must not replace either cookie from a newer login or logout.
                $response->headers->removeCookie($session->getName(), $config['path'], $config['domain']);
                $response->headers->removeCookie('XSRF-TOKEN', $config['path'], $config['domain']);

                if ($response->isSuccessful() && $handler->isNewId($session->getId())) {
                    return response()->json([
                        'message' => __('api.auth.session_unavailable'),
                    ], Response::HTTP_SERVICE_UNAVAILABLE)->header('Cache-Control', 'no-store');
                }
            }
        }

        return $response;
    }

    protected function startSession(Request $request, $session)
    {
        $session = parent::startSession($request, $session);
        $handler = $session->getHandler();

        if ($handler instanceof DatabaseSessionHandler && $handler->needsFreshId()) {
            $session->flush();
            $session->regenerate();
        }

        return $session;
    }
}
