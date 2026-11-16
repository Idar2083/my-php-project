<?php

declare(strict_types=1);

namespace App\Modules\Report\Domain\Enums;

enum ReportStatus: string
{
    case PENDING = 'pending';
    case PROCESSING = 'processing';
    case COMPLETED = 'completed';
    case FAILED = 'failed';
}
