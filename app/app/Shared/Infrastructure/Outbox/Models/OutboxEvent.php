<?php

declare(strict_types=1);

namespace App\Shared\Infrastructure\Outbox\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property string $event_id
 * @property string $event_type
 * @property array<string, mixed> $payload
 * @property \Illuminate\Support\Carbon $occurred_at
 * @property \Illuminate\Support\Carbon|null $published_at
 * @property int $attempts
 * @property string|null $last_error
 * @property \Illuminate\Support\Carbon|null $processing_at
 * @property string|null $processing_token
 * @property \Illuminate\Support\Carbon|null $failed_at
 */
final class OutboxEvent extends Model
{
    protected $table = 'outbox_events';

    protected $fillable = [
        'event_id',
        'event_type',
        'payload',
        'occurred_at',
        'published_at',
        'attempts',
        'last_error',
        'processing_at',
        'processing_token',
        'failed_at',
    ];

    protected function casts(): array
    {
        return [
            'payload' => 'array',
            'occurred_at' => 'datetime',
            'published_at' => 'datetime',
            'attempts' => 'integer',
            'processing_at' => 'datetime',
            'failed_at' => 'datetime',
        ];
    }
}
