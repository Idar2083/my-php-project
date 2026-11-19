<?php

declare(strict_types=1);

namespace App\Modules\Auth\Infrastructure\Session;

use Illuminate\Session\DatabaseSessionHandler as LaravelDatabaseSessionHandler;

final class DatabaseSessionHandler extends LaravelDatabaseSessionHandler
{
    private ?string $loadedId = null;

    private bool $loaded = false;

    private bool $saved = false;

    public function read($sessionId): string|false
    {
        $this->loadedId = $sessionId;
        $this->saved = false;
        $data = parent::read($sessionId);
        $this->loaded = $data !== false && $data !== '';

        return $data;
    }

    public function needsFreshId(): bool
    {
        return !$this->loaded;
    }

    public function isNewId(string $id): bool
    {
        return $this->loadedId !== null && $id !== $this->loadedId;
    }

    public function saved(): bool
    {
        return $this->saved;
    }

    public function write($sessionId, $data): bool
    {
        $this->saved = false;

        if ($this->loadedId === null) {
            return false;
        }

        $payload = $this->getDefaultPayload($data);
        if ($this->isNewId($sessionId)) {
            // Laravel issued a fresh ID. A collision must never overwrite another session.
            return $this->saved = $this->getQuery()->insertOrIgnore(['id' => $sessionId] + $payload) === 1;
        }

        // PostgreSQL serializes this update with logout's delete. A loaded ID cannot be inserted again.
        return $this->saved = $this->loaded && $this->getQuery()
            ->where('id', $sessionId)
            ->where('last_activity', '>=', $this->currentTime() - $this->minutes * 60)
            ->update($payload) === 1;
    }
}
