<?php

declare(strict_types=1);

namespace App\Modules\Report\Domain\Models;

use App\Modules\Report\Domain\Enums\ReportStatus;
use Illuminate\Database\Eloquent\Model;

/**
 * @property int $id
 * @property ReportStatus $status
 * @property \Illuminate\Support\Carbon $date_from
 * @property \Illuminate\Support\Carbon $date_to
 * @property string|null $file_path
 * @property string|null $error
 */
class Report extends Model
{
    protected $fillable = [
        'status',
        'date_from',
        'date_to',
        'file_path',
        'error',
    ];

    protected function casts(): array
    {
        return [
            'status' => ReportStatus::class,
            'date_from' => 'datetime',
            'date_to' => 'datetime',
        ];
    }
}
