<?php

declare(strict_types=1);

namespace App\Modules\Order\Presentation\OpenApi;

use OpenApi\Attributes as OA;

#[OA\Post(
    path: '/api/orders',
    operationId: 'createOrder',
    description: 'Creates an order from the current authenticated user cart. The server reads product prices and calculates the total; successful creation deletes cart items while retaining the cart. Missing or empty carts and a summed quantity above 30 produce 422. Repeating checkout after success encounters an empty cart. Address fields are flat in the request and nested in the response. Send Accept: application/json for JSON errors. Accept-Language selects English or Russian messages; examples use English.',
    summary: 'Create an order from the current cart',
    security: [['bearerAuth' => []]],
    requestBody: new OA\RequestBody(required: true, content: new OA\JsonContent(ref: '#/components/schemas/CreateOrderRequest', example: [
        'delivery_method' => 'delivery', 'region' => 'Moscow Region', 'city' => 'Moscow', 'street' => 'Tverskaya', 'house' => '1', 'postal_code' => '125009', 'entrance' => null, 'apartment' => null,
    ])),
    tags: ['Order'],
    responses: [
        new OA\Response(response: 201, description: 'Order created and cart items cleared.', content: new OA\JsonContent(ref: '#/components/schemas/CreateOrderResponse', example: ['data' => [
            'id' => 1, 'status' => 'created', 'total_price' => '1000.00', 'delivery_method' => 'delivery',
            'address' => ['region' => 'Moscow Region', 'city' => 'Moscow', 'street' => 'Tverskaya', 'house' => '1', 'entrance' => null, 'apartment' => null, 'postal_code' => '125009'],
            'items' => [['id' => 1, 'product_id' => 1, 'quantity' => 2, 'price' => '500.00', 'product' => ['id' => 1, 'name' => 'Pepperoni', 'price' => 500, 'category' => 'pizza', 'description' => 'Test product', 'weight' => '0.550']]],
            'created_at' => '2026-10-09T12:00:00.000000Z',
        ]])),
        new OA\Response(response: 401, description: 'Missing or invalid JWT.', content: new OA\JsonContent(ref: '#/components/schemas/MessageError', example: ['message' => 'Unauthenticated.'])),
        new OA\Response(response: 422, description: 'Required/string/address-length validation fails, the cart is missing or empty, or summed quantity exceeds 30. Business errors use the cart field.', content: new OA\JsonContent(ref: '#/components/schemas/ValidationError', examples: [
            new OA\Examples(example: 'emptyCart', summary: 'Missing or empty cart', value: ['message' => 'The cart must contain at least one product.', 'errors' => ['cart' => ['The cart must contain at least one product.']]]),
            new OA\Examples(example: 'quantityLimit', summary: 'Total quantity exceeds 30', value: ['message' => 'An order cannot contain more than 30 items.', 'errors' => ['cart' => ['An order cannot contain more than 30 items.']]]),
        ])),
    ],
)]
final class OrderOperations
{
}
