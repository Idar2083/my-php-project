<?php

declare(strict_types=1);

return [
    'auth' => [
        'invalid_credentials' => 'Invalid credentials.',
        'logged_out' => 'Successfully logged out.',
    ],

    'authorization' => [
        'unauthenticated' => 'Unauthenticated.',
        'forbidden' => 'Forbidden.',
    ],

    'categories' => [
        'pizza' => 'pizza',
        'drink' => 'drink',
    ],

    'cart' => [
        'empty' => 'The cart must contain at least one product.',
        'max_items' => 'The maximum number of :category items in the cart is :limit.',
        'unsupported_category' => 'Unsupported product category.',
    ],

    'order' => [
        'max_items' => 'An order cannot contain more than :max items.',
        'invalid_status' => 'Cannot update status of a :status order.',
    ],

    'report' => [
        'generation_unavailable' => 'Report generation is temporarily unavailable.',
        'file_unavailable' => 'Report file is not available.',
        'file_missing' => 'File missing in storage.',
    ],
];
