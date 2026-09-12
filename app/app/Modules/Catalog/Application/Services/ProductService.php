<?php

declare(strict_types=1);

namespace App\Modules\Catalog\Application\Services;

use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Contracts\Pagination\LengthAwarePaginator;
use Illuminate\Support\Facades\Cache;

class ProductService
{
    private const string CACHE_VERSION_KEY = 'products.version';

    private const string CACHE_KEY_PREFIX = 'products';

    /**
     * @return LengthAwarePaginator<int, Product>
     */
    public function paginate(int $page, int $perPage = 30): LengthAwarePaginator
    {
        $cacheKey = $this->buildCacheKey($page);

        /** @var array{
         *      items: array<int, Product>,
         *      total: int,
         *      current_page: int,
         *      per_page: int
         * } $cached
         */
        $cached = Cache::remember(
            $cacheKey,
            now()->addSeconds(
                (int) config('cache.products_ttl'),
            ),
            static function () use ($page, $perPage): array {
                $paginator = Product::query()
                    ->orderBy('id')
                    ->paginate(
                        perPage: $perPage,
                        page: $page,
                    );

                return [
                    'items' => $paginator->items(),
                    'total' => $paginator->total(),
                    'current_page' => $paginator->currentPage(),
                    'per_page' => $paginator->perPage(),
                ];
            },
        );

        return new \Illuminate\Pagination\LengthAwarePaginator(
            items: $cached['items'],
            total: $cached['total'],
            perPage: $cached['per_page'],
            currentPage: $cached['current_page'],
            options: [
                'path' => request()->url(),
                'query' => request()->query(),
            ],
        );
    }

    public function bumpCacheVersion(): void
    {
        Cache::add(
            self::CACHE_VERSION_KEY,
            0,
        );

        Cache::increment(
            self::CACHE_VERSION_KEY,
        );
    }

    private function buildCacheKey(int $page): string
    {
        return sprintf(
            '%s.v%d.page.%d',
            self::CACHE_KEY_PREFIX,
            $this->getCacheVersion(),
            $page,
        );
    }

    private function getCacheVersion(): int
    {
        return (int) Cache::get(
            self::CACHE_VERSION_KEY,
            1,
        );
    }
}
