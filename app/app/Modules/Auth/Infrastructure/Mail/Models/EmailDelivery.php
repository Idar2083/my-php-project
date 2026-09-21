<?php

declare(strict_types=1);

namespace App\Modules\Auth\Infrastructure\Mail\Models;

use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property string $event_id
 * @property string $message_type
 * @property string $recipient
 * @property \Illuminate\Support\Carbon|null $sent_at
 */
final class EmailDelivery extends Model
{
    protected $table = 'email_deliveries';

    protected $fillable = [
        'event_id',
        'message_type',
        'recipient',
        'sent_at',
    ];

    protected function casts(): array
    {
        return [
            'sent_at' => 'datetime',
        ];
    }
}
