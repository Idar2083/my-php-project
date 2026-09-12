<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Storage;

use App\Modules\Report\Application\Contracts\ReportStorage as ReportStorageContract;
use Illuminate\Support\Facades\Storage;

final class ReportStorage implements ReportStorageContract
{
    /**
     * @param resource $stream
     */
    public function put(
        string $path,
        $stream,
    ): void {
        if (!Storage::disk('s3')->put($path, $stream)) {
            throw new \RuntimeException(
                'Unable to upload report to object storage.',
            );
        }
    }

    public function exists(string $path): bool
    {
        return Storage::disk('s3')->exists($path);
    }

    /**
     * @return resource
     */
    public function readStream(string $path)
    {
        $stream = Storage::disk('s3')->readStream($path);

        if (!is_resource($stream)) {
            throw new \RuntimeException(
                sprintf(
                    'Unable to read report file "%s".',
                    $path,
                ),
            );
        }

        return $stream;
    }
}
