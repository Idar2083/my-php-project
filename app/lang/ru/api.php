<?php

declare(strict_types=1);

return [
    'auth' => [
        'invalid_credentials' => 'Неверные учетные данные.',
        'logged_out' => 'Вы успешно вышли из системы.',
    ],

    'authorization' => [
        'unauthenticated' => 'Необходима аутентификация.',
        'forbidden' => 'Доступ запрещен.',
    ],

    'categories' => [
        'pizza' => 'пицца',
        'drink' => 'напиток',
    ],

    'cart' => [
        'empty' => 'Корзина должна содержать хотя бы один товар.',
        'max_items' => 'Максимальное количество товаров категории «:category» в корзине — :limit.',
        'unsupported_category' => 'Неподдерживаемая категория товара.',
    ],

    'order' => [
        'max_items' => 'Заказ не может содержать более :max товаров.',
        'invalid_status' => 'Невозможно изменить статус заказа со статусом «:status».',
    ],

    'report' => [
        'generation_unavailable' => 'Генерация отчета временно недоступна.',
        'file_unavailable' => 'Файл отчета недоступен.',
        'file_missing' => 'Файл отсутствует в хранилище.',
    ],
];
