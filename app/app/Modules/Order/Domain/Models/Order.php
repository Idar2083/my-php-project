<?php

declare(strict_types=1);

namespace App\Modules\Order\Domain\Models;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Order\Domain\Enums\OrderStatus;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * @property int $id
 * @property int $user_id
 * @property OrderStatus $status
 * @property string $total_price
 * @property string $delivery_method
 * @property string $region
 * @property string $city
 * @property string $street
 * @property string $house
 * @property string|null $entrance
 * @property string|null $apartment
 * @property string|null $postal_code
 * @property Carbon|null $paid_at
 */
class Order extends Model
{
    protected $fillable = [
        'user_id',
        'status',
        'total_price',
        'delivery_method',
        'region',
        'city',
        'street',
        'house',
        'entrance',
        'apartment',
        'postal_code',
        'paid_at',
    ];

    /**
     * @return BelongsTo<User, $this>
     */
    public function user(): BelongsTo
    {
        return $this->belongsTo(User::class);
    }

    /**
     * @return HasMany<OrderItem, $this>
     */
    public function items(): HasMany
    {
        return $this->hasMany(OrderItem::class);
    }

    protected function casts(): array
    {
        return [
            'status' => OrderStatus::class,
            'total_price' => 'decimal:2',
            'paid_at' => 'datetime',
        ];
    }
}
