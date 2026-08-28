<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\DTO;

final readonly class ReportCompletedMessage
{
    public function __construct(
        public string $messageId,
        public int $reportId,
        public string $filePath,
        public \DateTimeImmutable $createdAt,
    ) {
        if ($this->messageId === '') {
            throw new \InvalidArgumentException(
                'Message ID must not be empty.',
            );
        }

        if ($this->reportId <= 0) {
            throw new \InvalidArgumentException(
                'Report ID must be greater than zero.',
            );
        }

        if ($this->filePath === '') {
            throw new \InvalidArgumentException(
                'Report file path must not be empty.',
            );
        }
    }

    /**
     * @return array{
     *     message_id: string,
     *     message_type: 'reports.completed',
     *     created_at: string,
     *     payload: array{
     *         report_id: int,
     *         file_path: string
     *     }
     * }
     */
    public function toArray(): array
    {
        return [
            'message_id' => $this->messageId,
            'message_type' => 'reports.completed',
            'created_at' => $this->createdAt->format(DATE_ATOM),
            'payload' => [
                'report_id' => $this->reportId,
                'file_path' => $this->filePath,
            ],
        ];
    }
}
