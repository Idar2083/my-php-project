<?php

declare(strict_types=1);

namespace App\Http\OpenApi\Support;

use L5Swagger\CustomGeneratorInterface;
use OpenApi\Generator;
use Psr\Log\AbstractLogger;
use Psr\Log\LogLevel;

final class StrictGeneratorFactory implements CustomGeneratorInterface
{
    public function create(): Generator
    {
        return new Generator(new class () extends AbstractLogger {
            public function log($level, string|\Stringable $message, array $context = []): void
            {
                if (in_array($level, [LogLevel::DEBUG, LogLevel::INFO, LogLevel::NOTICE], true)) {
                    return;
                }

                throw new \RuntimeException((string) $message);
            }
        });
    }
}
