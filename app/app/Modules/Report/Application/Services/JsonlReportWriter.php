<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\Services;

final class JsonlReportWriter
{
    private const int JSON_FLAGS =
        JSON_THROW_ON_ERROR
        | JSON_UNESCAPED_UNICODE
        | JSON_UNESCAPED_SLASHES;

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
            $price = (float) $row->price;

            for ($quantity = 0; $quantity < $row->quantity; ++$quantity) {
                try {
                    $line = json_encode(
                        [
                            'product_name' => $row->product_name,
                            'price' => $price,
                            'amount' => 1,
                            'user' => [
                                'id' => $row->user_id,
                            ],
                        ],
                        self::JSON_FLAGS,
                    );
                } catch (\JsonException $exception) {
                    throw new \RuntimeException(sprintf(
                        'Unable to encode order item %d for JSONL report.',
                        $row->order_item_id,
                    ), $exception->getCode(), previous: $exception);
                }

                $payload = $line . "\n";
                $written = $file->fwrite($payload);

                if ($written !== strlen($payload)) {
                    throw new \RuntimeException(sprintf(
                        'Unable to fully write report file "%s".',
                        $path,
                    ));
                }
            }
        }
    }
}
