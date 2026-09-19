<?php

declare(strict_types=1);

return [
    'required' => 'Поле «:attribute» обязательно для заполнения.',
    'string' => 'Поле «:attribute» должно быть строкой.',
    'integer' => 'Поле «:attribute» должно быть целым числом.',
    'numeric' => 'Поле «:attribute» должно быть числом.',
    'email' => 'Поле «:attribute» должно содержать корректный адрес электронной почты.',
    'exists' => 'Выбранное значение поля «:attribute» недействительно.',
    'unique' => 'Значение поля «:attribute» уже используется.',
    'max' => [
        'string' => 'Поле «:attribute» не должно содержать более :max символов.',
    ],
    'min' => [
        'string' => 'Поле «:attribute» должно содержать не менее :min символов.',
        'numeric' => 'Поле «:attribute» должно быть не меньше :min.',
    ],
    'gt' => [
        'numeric' => 'Поле «:attribute» должно быть больше :value.',
    ],
    'password' => [
        'mixed' => 'Поле «:attribute» должно содержать хотя бы одну заглавную и одну строчную букву.',
        'letters' => 'Поле «:attribute» должно содержать хотя бы одну букву.',
        'numbers' => 'Поле «:attribute» должно содержать хотя бы одну цифру.',
        'symbols' => 'Поле «:attribute» должно содержать хотя бы один специальный символ.',
    ],
    'date_format' => 'Поле «:attribute» должно соответствовать формату :format.',
    'after_or_equal' => 'Поле «:attribute» должно содержать дату не раньше :date.',
    'enum' => 'Выбранное значение поля «:attribute» недействительно.',
    'attributes' => [
        'name' => 'имя',
        'email' => 'электронная почта',
        'password' => 'пароль',
        'product_id' => 'товар',
        'quantity' => 'количество',
        'price' => 'цена',
        'category' => 'категория',
        'description' => 'описание',
        'weight' => 'вес',
        'region' => 'регион',
        'city' => 'город',
        'street' => 'улица',
        'house' => 'дом',
        'apartment' => 'квартира',
        'entrance' => 'подъезд',
        'postal_code' => 'почтовый индекс',
        'delivery_method' => 'способ доставки',
        'status' => 'статус',
        'date_from' => 'начальная дата',
        'date_to' => 'конечная дата',
    ],
];
