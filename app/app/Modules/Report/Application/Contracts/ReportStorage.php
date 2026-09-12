<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Contracts;

interface ReportStorage
{
    /**
     * @param resource $stream
     */
    public function put(
        string $path,
        $stream,
    ): void;

    public function exists(string $path): bool;

    /**
     * @return resource
     */
    public function readStream(string $path);
}
