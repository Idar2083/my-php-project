<?php

declare(strict_types=1);

namespace Tests\Feature\Report;

use App\Modules\Report\Infrastructure\Messaging\Console\GenerateDailyReport;
use App\Modules\Report\Infrastructure\Messaging\Console\SetupReportRabbitMq;
use App\Shared\Infrastructure\Outbox\Console\ProcessOutbox;
use Illuminate\Contracts\Console\Kernel;
use Tests\TestCase;

final class ReportCommandRegistrationTest extends TestCase
{
    public function test_report_and_outbox_commands_are_registered(): void
    {
        $commands = app(Kernel::class)->all();

        $this->assertArrayHasKey('reports:generate-daily', $commands);
        $this->assertInstanceOf(GenerateDailyReport::class, $commands['reports:generate-daily']);
        $this->assertArrayHasKey('reports:rabbitmq:setup', $commands);
        $this->assertInstanceOf(SetupReportRabbitMq::class, $commands['reports:rabbitmq:setup']);
        $this->assertArrayHasKey('outbox:process', $commands);
        $this->assertInstanceOf(ProcessOutbox::class, $commands['outbox:process']);
    }
}
