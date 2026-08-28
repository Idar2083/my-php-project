<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Persistence;

use App\Modules\Order\Domain\Enums\OrderStatus;
use App\Modules\Report\Application\Contracts\ReportOrderItemReader;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\LazyCollection;

final class ReportOrderItemQuery implements ReportOrderItemReader
{
    /**
     * @return LazyCollection<int, \stdClass>
     */
    public function between(
        \DateTimeInterface $dateFrom,
        \DateTimeInterface $dateTo,
    ): LazyCollection {
        return DB::table('order_items')
            ->join(
                'orders',
                'orders.id',
                '=',
                'order_items.order_id',
            )
            ->join(
                'products',
                'products.id',
                '=',
                'order_items.product_id',
            )
            ->select([
                'order_items.id as order_item_id',
                'products.name as product_name',
                'order_items.price',
                'order_items.quantity',
                'orders.user_id',
            ])
            ->whereBetween(
                'orders.created_at',
                [$dateFrom, $dateTo],
            )
            ->where(
                'orders.status',
                '!=',
                OrderStatus::CANCELLED->value,
            )
            ->orderBy('order_items.id')
            ->lazyById(
                chunkSize: 1_000,
                column: 'order_items.id',
                alias: 'order_item_id',
            );
    }
}
