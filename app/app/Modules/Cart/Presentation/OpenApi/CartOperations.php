<?php

declare(strict_types=1);

namespace App\Modules\Cart\Presentation\OpenApi;

use OpenApi\Attributes as OA;

#[OA\Post(
    path: '/api/cart/items',
    operationId: 'addCartItem',
    description: 'Adds to the authenticated user cart and returns the entire cart. Repeating the request increases the existing item quantity, so this operation is not idempotent. Category totals across all products are limited to 10 pizza items and 20 drink items. Categories are case-sensitive: only pizza and drink are supported. Send Accept: application/json for JSON error responses. Accept-Language selects English or Russian error messages; examples use English.',
    summary: 'Add a product to the cart',
    security: [['bearerAuth' => []]],
    requestBody: new OA\RequestBody(
        required: true,
        content: new OA\JsonContent(ref: '#/components/schemas/AddCartItemRequest', example: ['product_id' => 1, 'quantity' => 2]),
    ),
    tags: ['Cart'],
    responses: [
        new OA\Response(
            response: 200,
            description: 'Entire cart after adding the quantity, including when the cart is first created.',
            content: new OA\JsonContent(
                ref: '#/components/schemas/CartResponse',
                example: [
                    'data' => [
                        'id' => 1,
                        'user_id' => 1,
                        'items' => [[
                            'id' => 1,
                            'product_id' => 1,
                            'quantity' => 2,
                            'product' => [
                                'id' => 1,
                                'name' => 'Pepperoni',
                                'price' => 500,
                                'category' => 'pizza',
                                'description' => 'Test product',
                                'weight' => '0.550',
                            ],
                        ]],
                    ],
                ],
            ),
        ),
        new OA\Response(
            response: 401,
            description: 'Missing or invalid JWT authentication.',
            content: new OA\JsonContent(ref: '#/components/schemas/MessageError', example: ['message' => 'Unauthenticated.']),
        ),
        new OA\Response(
            response: 404,
            description: 'A product can disappear after the exists validation and before CartService reads it using findOrFail. A product already missing at validation produces 422 instead. The message is framework-generated and may include debug fields; no stable message example is promised.',
            content: new OA\JsonContent(ref: '#/components/schemas/MessageError'),
        ),
        new OA\Response(
            response: 422,
            description: 'Request validation or business-rule failure: missing/non-integer fields, quantity below 1, nonexistent product, unsupported category (product_id), or category limit exceeded (quantity).',
            content: new OA\JsonContent(
                ref: '#/components/schemas/ValidationError',
                examples: [
                    new OA\Examples(
                        example: 'pizzaLimit',
                        summary: 'Total pizza quantity exceeds 10',
                        value: ['message' => 'The maximum number of pizza items in the cart is 10.', 'errors' => ['quantity' => ['The maximum number of pizza items in the cart is 10.']]],
                    ),
                    new OA\Examples(
                        example: 'drinkLimit',
                        summary: 'Total drink quantity exceeds 20',
                        value: ['message' => 'The maximum number of drink items in the cart is 20.', 'errors' => ['quantity' => ['The maximum number of drink items in the cart is 20.']]],
                    ),
                    new OA\Examples(
                        example: 'unsupportedCategory',
                        summary: 'Unsupported product category',
                        value: ['message' => 'Unsupported product category.', 'errors' => ['product_id' => ['Unsupported product category.']]],
                    ),
                ],
            ),
        ),
    ],
)]
final class CartOperations
{
}
