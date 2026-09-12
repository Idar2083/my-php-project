<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Contracts;

use App\Modules\Report\Application\DTO\ReportCompletedMessage;

interface ReportCompletionPublisher
{
    public function publishCompleted(
        ReportCompletedMessage $message,
    ): void;
}
