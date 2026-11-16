<?php

declare(strict_types=1);

namespace App\Modules\Catalog\Domain\Models;

use Database\Factories\ProductFactory;
use Illuminate\Database\Eloquent\Casts\Attribute;
use Illuminate\Database\Eloquent\Factories\HasFactory;
use Illuminate\Database\Eloquent\Model;

class Product extends Model
{
    /** @use HasFactory<ProductFactory> */
    use HasFactory;

    public const string MAX_PRICE = '21474836.47';

    protected $fillable = [
        'name',
        'description',
        'price',
        'weight',
        'category',
    ];

    protected function casts(): array
    {
        return [
            'weight' => 'decimal:3',
        ];
    }

    /**
     * @return Attribute<float, int|float|string>
     */
    protected function price(): Attribute
    {
        return Attribute::make(
            get: static fn (int $value): float => $value / 100,
            set: $this->priceInCents(...),
        );
    }

    protected static function newFactory(): ProductFactory
    {
        return ProductFactory::new();
    }

    private function priceInCents(int|float|string $value): int
    {
        $decimal = (string) $value;
        if (!preg_match('/^\d+(?:\.\d{1,2})?$/D', $decimal)) {
            throw new \InvalidArgumentException('Price must be nonnegative with at most two decimal places.');
        }
        [$whole, $fraction] = array_pad(explode('.', $decimal), 2, '');
        $whole = ltrim($whole, '0');
        if (strlen($whole) > 8) {
            throw new \InvalidArgumentException('Price exceeds the PostgreSQL integer range.');
        }
        $cents = (int) $whole * 100 + (int) str_pad($fraction, 2, '0');
        if ($cents > 2_147_483_647) {
            throw new \InvalidArgumentException('Price exceeds the PostgreSQL integer range.');
        }

        return $cents;
    }
}
