<?php

declare(strict_types=1);

namespace App\Modules\Order\Presentation\OpenApi;

use OpenApi\Attributes as OA;

#[OA\Schema(
    schema: 'CreateOrderRequest',
    required: ['region', 'city', 'street', 'house', 'postal_code', 'delivery_method'],
    properties: [
        new OA\Property(property: 'region', type: 'string', maxLength: 255, minLength: 1),
        new OA\Property(property: 'city', type: 'string', maxLength: 255, minLength: 1),
        new OA\Property(property: 'street', type: 'string', maxLength: 255, minLength: 1),
        new OA\Property(property: 'house', type: 'string', maxLength: 255, minLength: 1),
        new OA\Property(property: 'postal_code', type: 'string', maxLength: 255, minLength: 1),
        new OA\Property(property: 'entrance', type: 'string', nullable: true, maxLength: 255),
        new OA\Property(property: 'apartment', type: 'string', nullable: true, maxLength: 255),
        new OA\Property(property: 'delivery_method', description: 'Required string; no enum or maximum length is validated by StoreOrderRequest.', type: 'string', minLength: 1),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'OrderAddress',
    required: ['region', 'city', 'street', 'house', 'postal_code', 'entrance', 'apartment'],
    properties: [
        new OA\Property(property: 'region', type: 'string'),
        new OA\Property(property: 'city', type: 'string'),
        new OA\Property(property: 'street', type: 'string'),
        new OA\Property(property: 'house', type: 'string'),
        new OA\Property(property: 'postal_code', type: 'string'),
        new OA\Property(property: 'entrance', type: 'string', nullable: true),
        new OA\Property(property: 'apartment', type: 'string', nullable: true),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'OrderItem',
    required: ['id', 'product_id', 'quantity', 'price', 'product'],
    properties: [
        new OA\Property(property: 'id', type: 'integer'),
        new OA\Property(property: 'product_id', type: 'integer'),
        new OA\Property(property: 'quantity', type: 'integer'),
        new OA\Property(property: 'price', description: 'Server-side unit price snapshot, decimal serialized as a string with two decimal places.', type: 'string', example: '500.00'),
        new OA\Property(property: 'product', ref: '#/components/schemas/Product'),
    ],
    type: 'object',
)]
#[OA\Schema(
    schema: 'CreatedOrder',
    required: ['id', 'status', 'total_price', 'delivery_method', 'address', 'items', 'created_at'],
    properties: [
        new OA\Property(property: 'id', type: 'integer'),
        new OA\Property(property: 'status', description: 'Initial status returned by this creation operation.', type: 'string', enum: ['created']),
        new OA\Property(property: 'total_price', description: 'Server-calculated sum of unit price times quantity; decimal serialized as a string with two decimal places.', type: 'string', example: '1000.00'),
        new OA\Property(property: 'delivery_method', type: 'string'),
        new OA\Property(property: 'address', ref: '#/components/schemas/OrderAddress'),
        new OA\Property(property: 'items', type: 'array', items: new OA\Items(ref: '#/components/schemas/OrderItem')),
        new OA\Property(property: 'created_at', type: 'string', format: 'date-time'),
    ],
    type: 'object',
)]
#[OA\Schema(schema: 'CreateOrderResponse', required: ['data'], properties: [new OA\Property(property: 'data', ref: '#/components/schemas/CreatedOrder')], type: 'object')]
final class OrderSchemas
{
}
