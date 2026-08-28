<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Services;

final class JsonlReportWriter
{
    /**
     * @param iterable<object{
     *     order_item_id: int,
     *     product_name: string,
     *     price: string,
     *     quantity: int,
     *     user_id: int
     * }> $rows
     */
    public function write(
        iterable $rows,
        string $path,
    ): void {
        try {
            $file = new \SplFileObject(
                $path,
                'wb',
            );
        } catch (\Throwable $exception) {
            throw new \RuntimeException(sprintf(
                'Unable to open report file "%s" for writing.',
                $path,
            ), $exception->getCode(), previous: $exception);
        }

        foreach ($rows as $row) {
            try {
                $line = json_encode(
                    [
                        'product_name' => $row->product_name,
                        'price' => $row->price,
                        'amount' => $row->quantity,
                        'user' => [
                            'id' => $row->user_id,
                        ],
                    ],
                    JSON_THROW_ON_ERROR
                    | JSON_UNESCAPED_UNICODE
                    | JSON_UNESCAPED_SLASHES,
                );
            } catch (\JsonException $exception) {
                throw new \RuntimeException(sprintf(
                    'Unable to encode order item %d for JSONL report.',
                    $row->order_item_id,
                ), $exception->getCode(), previous: $exception);
            }

            $data = $line . PHP_EOL;
            $written = $file->fwrite($data);

            if ($written !== strlen($data)) {
                throw new \RuntimeException(
                    sprintf(
                        'Unable to fully write report file "%s".',
                        $path,
                    ),
                );
            }
        }
    }
}
