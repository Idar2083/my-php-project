<?php

declare(strict_types=1);

namespace App\Modules\Report\Infrastructure\Messaging;

use App\Modules\Report\Application\DTO\ReportGenerationMessage;
use App\Modules\Report\Application\Exceptions\InvalidReportMessageException;

final class ReportMessageDecoder
{
    public function decode(string $body): ReportGenerationMessage
    {
        $data = $this->decodeJson($body);

        if (
            !isset($data['message_id'])
            || !is_string($data['message_id'])
            || $data['message_id'] === ''
        ) {
            throw new InvalidReportMessageException(
                'RabbitMQ message_id is missing or invalid.',
            );
        }

        if (
            !isset($data['message_type'])
            || !is_string($data['message_type'])
            || $data['message_type'] !== 'reports.generate'
        ) {
            throw new InvalidReportMessageException(
                'RabbitMQ message_type is missing or invalid.',
            );
        }

        if (
            !isset($data['attempt'])
            || !is_int($data['attempt'])
            || $data['attempt'] < 1
        ) {
            throw new InvalidReportMessageException(
                'RabbitMQ attempt is missing or invalid.',
            );
        }

        if (
            !isset($data['created_at'])
            || !is_string($data['created_at'])
            || $data['created_at'] === ''
        ) {
            throw new InvalidReportMessageException(
                'RabbitMQ created_at is missing or invalid.',
            );
        }

        if (
            !isset($data['payload'])
            || !is_array($data['payload'])
        ) {
            throw new InvalidReportMessageException(
                'RabbitMQ payload is missing or invalid.',
            );
        }

        $payload = $data['payload'];

        if (
            !isset($payload['report_id'])
            || !is_int($payload['report_id'])
            || $payload['report_id'] <= 0
        ) {
            throw new InvalidReportMessageException(
                'RabbitMQ report_id is missing or invalid.',
            );
        }

        if (
            !isset($payload['date_from'])
            || !is_string($payload['date_from'])
            || $payload['date_from'] === ''
        ) {
            throw new InvalidReportMessageException(
                'RabbitMQ date_from is missing or invalid.',
            );
        }

        if (
            !isset($payload['date_to'])
            || !is_string($payload['date_to'])
            || $payload['date_to'] === ''
        ) {
            throw new InvalidReportMessageException(
                'RabbitMQ date_to is missing or invalid.',
            );
        }

        try {
            return ReportGenerationMessage::fromArray([
                'message_id' => $data['message_id'],
                'message_type' => $data['message_type'],
                'attempt' => $data['attempt'],
                'created_at' => $data['created_at'],
                'payload' => [
                    'report_id' => $payload['report_id'],
                    'date_from' => $payload['date_from'],
                    'date_to' => $payload['date_to'],
                ],
            ]);
        } catch (\Throwable $exception) {
            throw new InvalidReportMessageException('RabbitMQ report message is invalid.', $exception->getCode(), previous: $exception);
        }
    }

    /**
     * @return array<string, mixed>
     */
    private function decodeJson(string $body): array
    {
        try {
            $data = json_decode(
                $body,
                true,
                512,
                JSON_THROW_ON_ERROR,
            );
        } catch (\Throwable $exception) {
            throw new InvalidReportMessageException('RabbitMQ message contains invalid JSON.', $exception->getCode(), previous: $exception);
        }

        if (!is_array($data)) {
            throw new InvalidReportMessageException(
                'RabbitMQ message must decode to an array.',
            );
        }

        return $data;
    }
}
