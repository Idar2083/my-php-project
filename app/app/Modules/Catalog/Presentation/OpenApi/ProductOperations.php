<?php

declare(strict_types=1);

namespace App\Modules\Catalog\Presentation\OpenApi;

use OpenApi\Attributes as OA;

#[OA\Get(
    path: '/api/products',
    operationId: 'listProducts',
    description: 'Public catalog ordered by id ascending, with 30 products per page. No filters, configurable sorting, or per_page parameter are supported. The page input is converted to an integer by Laravel without Form Request validation; no validation-error response is guaranteed. Empty and out-of-range pages return an empty data array. Pagination URLs use the request origin. No operation-specific error responses are defined; infrastructure failures are not a stable catalog error contract.',
    summary: 'List products',
    security: [],
    tags: ['Catalog'],
    parameters: [
        new OA\Parameter(
            name: 'page',
            description: 'Page number. Defaults to 1. Invalid values are not rejected by a dedicated validator.',
            in: 'query',
            required: false,
            schema: new OA\Schema(type: 'integer', default: 1),
            example: 1,
        ),
    ],
    responses: [
        new OA\Response(
            response: 200,
            description: 'Paginated products, including an empty catalog or a page beyond the last page.',
            content: new OA\JsonContent(
                ref: '#/components/schemas/ProductPage',
                examples: [
                    new OA\Examples(
                        example: 'singleProduct',
                        summary: 'First page with one product',
                        description: 'Pagination URLs are shown without the dynamic request origin; the API returns absolute URLs.',
                        value: [
                            'data' => [[
                                'id' => 1,
                                'name' => 'Pepperoni',
                                'price' => 500,
                                'category' => 'pizza',
                                'description' => 'Test product',
                                'weight' => '0.550',
                            ]],
                            'links' => [
                                'first' => '/api/products?page=1',
                                'last' => '/api/products?page=1',
                                'prev' => null,
                                'next' => null,
                            ],
                            'meta' => [
                                'current_page' => 1,
                                'from' => 1,
                                'last_page' => 1,
                                'links' => [
                                    ['url' => null, 'label' => '&laquo; Previous', 'page' => null, 'active' => false],
                                    ['url' => '/api/products?page=1', 'label' => '1', 'page' => 1, 'active' => true],
                                    ['url' => null, 'label' => 'Next &raquo;', 'page' => null, 'active' => false],
                                ],
                                'path' => '/api/products',
                                'per_page' => 30,
                                'to' => 1,
                                'total' => 1,
                            ],
                        ],
                    ),
                    new OA\Examples(
                        example: 'emptyCatalog',
                        summary: 'Empty catalog',
                        description: 'Pagination URLs are shown without the dynamic request origin; the API returns absolute URLs.',
                        value: [
                            'data' => [],
                            'links' => [
                                'first' => '/api/products?page=1',
                                'last' => '/api/products?page=1',
                                'prev' => null,
                                'next' => null,
                            ],
                            'meta' => [
                                'current_page' => 1,
                                'from' => null,
                                'last_page' => 1,
                                'links' => [
                                    ['url' => null, 'label' => '&laquo; Previous', 'page' => null, 'active' => false],
                                    ['url' => '/api/products?page=1', 'label' => '1', 'page' => 1, 'active' => true],
                                    ['url' => null, 'label' => 'Next &raquo;', 'page' => null, 'active' => false],
                                ],
                                'path' => '/api/products',
                                'per_page' => 30,
                                'to' => null,
                                'total' => 0,
                            ],
                        ],
                    ),
                ],
            ),
        ),
    ],
)]
final class ProductOperations
{
}
