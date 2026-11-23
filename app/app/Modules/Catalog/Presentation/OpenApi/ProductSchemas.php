<?php

declare(strict_types=1);

namespace App\Modules\Catalog\Presentation\OpenApi;

use OpenApi\Attributes as OA;

#[OA\Schema(
    schema: 'Product',
    required: ['id', 'name', 'price', 'category', 'description', 'weight'],
    properties: [
        new OA\Property(property: 'id', type: 'integer', example: 1),
        new OA\Property(property: 'name', type: 'string', example: 'Pepperoni'),
        new OA\Property(property: 'price', type: 'number', example: 500),
        new OA\Property(property: 'category', type: 'string', example: 'pizza'),
        new OA\Property(property: 'description', type: 'string', example: 'Test product', nullable: true),
        new OA\Property(property: 'weight', description: 'Decimal serialized as a string with three decimal places.', type: 'string', example: '0.550'),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'ProductPaginationLinks',
    required: ['first', 'last', 'prev', 'next'],
    properties: [
        new OA\Property(property: 'first', type: 'string'),
        new OA\Property(property: 'last', type: 'string'),
        new OA\Property(property: 'prev', type: 'string', nullable: true),
        new OA\Property(property: 'next', type: 'string', nullable: true),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'ProductPaginationLink',
    required: ['url', 'label', 'active'],
    properties: [
        new OA\Property(property: 'url', type: 'string', nullable: true),
        new OA\Property(property: 'label', description: 'Page number, localized navigation label, or ellipsis.', type: 'string'),
        new OA\Property(property: 'page', description: 'Absent on ellipsis entries; nullable on navigation links.', type: 'integer', nullable: true),
        new OA\Property(property: 'active', type: 'boolean'),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'ProductPaginationMeta',
    required: ['current_page', 'from', 'last_page', 'links', 'path', 'per_page', 'to', 'total'],
    properties: [
        new OA\Property(property: 'current_page', type: 'integer'),
        new OA\Property(property: 'from', type: 'integer', nullable: true),
        new OA\Property(property: 'last_page', type: 'integer'),
        new OA\Property(property: 'links', type: 'array', items: new OA\Items(ref: '#/components/schemas/ProductPaginationLink')),
        new OA\Property(property: 'path', type: 'string'),
        new OA\Property(property: 'per_page', type: 'integer', enum: [30]),
        new OA\Property(property: 'to', type: 'integer', nullable: true),
        new OA\Property(property: 'total', type: 'integer'),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'ProductPage',
    required: ['data', 'links', 'meta'],
    properties: [
        new OA\Property(property: 'data', type: 'array', items: new OA\Items(ref: '#/components/schemas/Product')),
        new OA\Property(property: 'links', ref: '#/components/schemas/ProductPaginationLinks'),
        new OA\Property(property: 'meta', ref: '#/components/schemas/ProductPaginationMeta'),
    ],
    type: 'object',
)]
final class ProductSchemas
{
}
