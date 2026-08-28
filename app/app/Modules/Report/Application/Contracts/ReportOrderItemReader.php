<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Contracts;

use Illuminate\Support\LazyCollection;

interface ReportOrderItemReader
{
    /**
     * @return LazyCollection<int, \stdClass>
     */
    public function between(
        \DateTimeInterface $dateFrom,
        \DateTimeInterface $dateTo,
    ): LazyCollection;
}
