<?php

declare(strict_types=1);

namespace App\DTO;

final readonly class AddressDto
{
    public function __construct(
        public string $deliveryMethod,
        public string $region,
        public string $city,
        public string $street,
        public string $house,
        public ?string $entrance,
        public ?string $apartment,
        public string $postalCode,
    ) {
    }

    /**
     * @param array{
     *     delivery_method: string,
     *     region: string,
     *     city: string,
     *     street: string,
     *     house: string,
     *     entrance?: string|null,
     *     apartment?: string|null,
     *     postal_code: string
     * } $data
     */
    public static function fromArray(array $data): self
    {
        return new self(
            deliveryMethod: $data['delivery_method'],
            region: $data['region'],
            city: $data['city'],
            street: $data['street'],
            house: $data['house'],
            entrance: $data['entrance'] ?? null,
            apartment: $data['apartment'] ?? null,
            postalCode: $data['postal_code'],
        );
    }
}
