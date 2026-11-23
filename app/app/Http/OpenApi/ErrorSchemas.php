<?php

declare(strict_types=1);

namespace App\Http\OpenApi;

use OpenApi\Attributes as OA;

#[OA\Schema(
    schema: 'MessageError',
    required: ['message'],
    properties: [new OA\Property(property: 'message', type: 'string')],
    type: 'object',
)]
#[OA\Schema(
    schema: 'ValidationError',
    required: ['message', 'errors'],
    properties: [
        new OA\Property(property: 'message', type: 'string'),
        new OA\Property(
            property: 'errors',
            type: 'object',
            additionalProperties: new OA\AdditionalProperties(type: 'array', items: new OA\Items(type: 'string')),
        ),
    ],
    type: 'object',
)]
final class ErrorSchemas
{
}
