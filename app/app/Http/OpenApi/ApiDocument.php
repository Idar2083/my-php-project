<?php

declare(strict_types=1);

namespace App\Http\OpenApi;

use OpenApi\Attributes as OA;

#[OA\Info(version: '1.0.0', description: 'Documentation of the existing pizza store API.', title: 'Pizza API')]
#[OA\Server(url: '/', description: 'Current origin')]
#[OA\Tag(name: 'Catalog', description: 'Public product catalog')]
#[OA\Tag(name: 'Cart', description: 'Authenticated user cart')]
#[OA\Tag(name: 'Order', description: 'Checkout from the authenticated user cart')]
#[OA\SecurityScheme(securityScheme: 'bearerAuth', type: 'http', description: 'JWT from POST /api/login or POST /api/register. Enter the token without the Bearer prefix.', bearerFormat: 'JWT', scheme: 'bearer')]
final class ApiDocument
{
}
