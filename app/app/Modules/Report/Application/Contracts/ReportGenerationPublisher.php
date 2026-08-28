<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Contracts;

use App\Modules\Report\Application\DTO\ReportGenerationMessage;

interface ReportGenerationPublisher
{
    public function publishGeneration(
        ReportGenerationMessage $message,
    ): void;
}
