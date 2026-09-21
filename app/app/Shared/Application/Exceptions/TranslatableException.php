<?php

declare(strict_types=1);

namespace App\Shared\Application\Exceptions;

final class TranslatableException extends \Exception
{
    /**
     * @param array<string, scalar|null> $parameters
     */
    public function __construct(
        private readonly string $translationKey,
        private readonly array $parameters = [],
        private readonly int $statusCode = 409,
    ) {
        parent::__construct($translationKey);
    }

    public function translationKey(): string
    {
        return $this->translationKey;
    }

    /**
     * @return array<string, scalar|null>
     */
    public function parameters(): array
    {
        return $this->parameters;
    }

    public function statusCode(): int
    {
        return $this->statusCode;
    }
}
