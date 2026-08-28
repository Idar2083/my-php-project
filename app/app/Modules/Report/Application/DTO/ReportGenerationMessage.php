<?php

declare(strict_types=1);

namespace App\Modules\Report\Application\DTO;

final readonly class ReportGenerationMessage
{
    public function __construct(
        public string $messageId,
        public int $reportId,
        public \DateTimeImmutable $dateFrom,
        public \DateTimeImmutable $dateTo,
        public \DateTimeImmutable $createdAt,
        public int $attempt = 1,
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

        if ($this->dateFrom > $this->dateTo) {
            throw new \InvalidArgumentException(
                'Report start date must not be after end date.',
            );
        }

        if ($this->attempt < 1) {
            throw new \InvalidArgumentException(
                'Message attempt must be greater than zero.',
            );
        }
    }

    /**
     * @param array{
     *     message_id: string,
     *     message_type: string,
     *     attempt: int,
     *     created_at: string,
     *     payload: array{
     *         report_id: int,
     *         date_from: string,
     *         date_to: string
     *     }
     * } $data
     */
    public static function fromArray(array $data): self
    {
        if ($data['message_type'] !== 'reports.generate') {
            throw new \InvalidArgumentException(
                'Invalid report message type.',
            );
        }

        return new self(
            messageId: $data['message_id'],
            reportId: $data['payload']['report_id'],
            dateFrom: new \DateTimeImmutable(
                $data['payload']['date_from'],
            ),
            dateTo: new \DateTimeImmutable(
                $data['payload']['date_to'],
            ),
            createdAt: new \DateTimeImmutable(
                $data['created_at'],
            ),
            attempt: $data['attempt'],
        );
    }

    /**
     * @return array{
     *     message_id: string,
     *     message_type: 'reports.generate',
     *     attempt: int,
     *     created_at: string,
     *     payload: array{
     *         report_id: int,
     *         date_from: string,
     *         date_to: string
     *     }
     * }
     */
    public function toArray(): array
    {
        return [
            'message_id' => $this->messageId,
            'message_type' => 'reports.generate',
            'attempt' => $this->attempt,
            'created_at' => $this->createdAt->format(DATE_ATOM),
            'payload' => [
                'report_id' => $this->reportId,
                'date_from' => $this->dateFrom->format(DATE_ATOM),
                'date_to' => $this->dateTo->format(DATE_ATOM),
            ],
        ];
    }

    public function nextAttempt(): self
    {
        return new self(
            messageId: $this->messageId,
            reportId: $this->reportId,
            dateFrom: $this->dateFrom,
            dateTo: $this->dateTo,
            createdAt: $this->createdAt,
            attempt: $this->attempt + 1,
        );
    }
}
