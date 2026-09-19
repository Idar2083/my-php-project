<?php

declare(strict_types=1);

return [
    'required' => 'The :attribute field is required.',
    'string' => 'The :attribute field must be a string.',
    'integer' => 'The :attribute field must be an integer.',
    'numeric' => 'The :attribute field must be a number.',
    'email' => 'The :attribute field must be a valid email address.',
    'exists' => 'The selected :attribute is invalid.',
    'unique' => 'The :attribute has already been taken.',
    'max' => [
        'string' => 'The :attribute field must not be greater than :max characters.',
    ],
    'min' => [
        'string' => 'The :attribute field must be at least :min characters.',
        'numeric' => 'The :attribute field must be at least :min.',
    ],
    'gt' => [
        'numeric' => 'The :attribute field must be greater than :value.',
    ],
    'password' => [
        'mixed' => 'The :attribute field must contain at least one uppercase and one lowercase letter.',
        'letters' => 'The :attribute field must contain at least one letter.',
        'numbers' => 'The :attribute field must contain at least one number.',
        'symbols' => 'The :attribute field must contain at least one symbol.',
    ],
    'date_format' => 'The :attribute field must match the format :format.',
    'after_or_equal' => 'The :attribute field must be a date after or equal to :date.',
    'enum' => 'The selected :attribute is invalid.',
    'attributes' => [
        'name' => 'name',
        'email' => 'email',
        'password' => 'password',
        'product_id' => 'product',
        'quantity' => 'quantity',
        'price' => 'price',
        'category' => 'category',
        'description' => 'description',
        'weight' => 'weight',
        'region' => 'region',
        'city' => 'city',
        'street' => 'street',
        'house' => 'house',
        'apartment' => 'apartment',
        'entrance' => 'entrance',
        'postal_code' => 'postal code',
        'delivery_method' => 'delivery method',
        'status' => 'status',
        'date_from' => 'start date',
        'date_to' => 'end date',
    ],
];
