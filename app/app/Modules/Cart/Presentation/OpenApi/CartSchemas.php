<?php

declare(strict_types=1);

namespace App\Modules\Cart\Presentation\OpenApi;

use OpenApi\Attributes as OA;

#[OA\Schema(
    schema: 'AddCartItemRequest',
    required: ['product_id', 'quantity'],
    properties: [
        new OA\Property(property: 'product_id', description: 'ID of an existing product. Only pizza and drink categories can be added.', type: 'integer', example: 1),
        new OA\Property(property: 'quantity', description: 'Quantity to add, not the final quantity. Category totals may not exceed 10 pizzas or 20 drinks.', type: 'integer', example: 2, minimum: 1),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'CartItem',
    required: ['id', 'product_id', 'quantity', 'product'],
    properties: [
        new OA\Property(property: 'id', type: 'integer'),
        new OA\Property(property: 'product_id', type: 'integer'),
        new OA\Property(property: 'quantity', type: 'integer'),
        new OA\Property(property: 'product', ref: '#/components/schemas/Product'),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'Cart',
    required: ['id', 'user_id', 'items'],
    properties: [
        new OA\Property(property: 'id', type: 'integer'),
        new OA\Property(property: 'user_id', type: 'integer'),
        new OA\Property(property: 'items', type: 'array', items: new OA\Items(ref: '#/components/schemas/CartItem')),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'CartResponse',
    required: ['data'],
    properties: [new OA\Property(property: 'data', ref: '#/components/schemas/Cart')],
    type: 'object',
)]
final class CartSchemas
{
}
