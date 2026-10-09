<?php

declare(strict_types=1);

namespace App\Modules\Auth\Application\Handlers;

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use App\Shared\Application\Exceptions\TranslatableException;
use Illuminate\Auth\Access\AuthorizationException;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Support\Facades\DB;

final class ChangeUserRoleHandler
{
    public function handle(int $actorId, int $userId, UserRole $role): User
    {
        return DB::transaction(function () use ($actorId, $userId, $role): User {
            $ids = array_unique([$actorId, $userId]);
            sort($ids, SORT_NUMERIC);

            $users = [];

            // Lock both participants in the same order for every role writer.
            foreach ($ids as $id) {
                $users[$id] = User::query()->lockForUpdate()->find($id);
            }

            $actor = $users[$actorId];

            // Middleware may have authorized this actor before a concurrent demotion.
            if ($actor === null || $actor->role !== UserRole::ADMIN) {
                throw new AuthorizationException();
            }

            $user = $users[$userId];

            if ($user === null) {
                throw (new ModelNotFoundException())->setModel(User::class, [$userId]);
            }

            if ($user->role === $role) {
                return $user;
            }

            if ($user->role === UserRole::ADMIN && $role === UserRole::USER) {
                if (! User::query()->where('role', UserRole::ADMIN)
                    ->where('id', '!=', $userId)->exists()) {
                    throw new TranslatableException('api.auth.last_admin');
                }

                if ($actorId === $userId) {
                    throw new TranslatableException('api.auth.self_demotion');
                }
            }

            // A distinct, locked administrator always survives an allowed demotion.
            $user->role = $role;
            $user->save();

            return $user;
        }, 3);
    }
}
