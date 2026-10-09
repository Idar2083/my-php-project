<?php

declare(strict_types=1);

namespace App\Modules\Auth\Presentation\Controllers;

use App\Http\Controllers\Controller;
use App\Modules\Auth\Application\Handlers\ChangeUserRoleHandler;
use App\Modules\Auth\Domain\Models\User;
use App\Modules\Auth\Presentation\Requests\IndexUsersRequest;
use App\Modules\Auth\Presentation\Requests\UpdateUserRoleRequest;
use App\Modules\Auth\Presentation\Resources\AdminUserResource;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Illuminate\Pagination\LengthAwarePaginator;
use Symfony\Component\HttpFoundation\Response;

final class AdminUserController extends Controller
{
    public function __construct(
        private readonly ChangeUserRoleHandler $changeUserRoleHandler,
    ) {
    }

    public function index(IndexUsersRequest $request): AnonymousResourceCollection
    {
        $query = User::query()
            ->select(['id', 'name', 'email', 'role', 'created_at'])
            ->orderBy('id');
        $page = $request->getPage();
        $perPage = $request->getPerPage();
        $total = $query->count();

        // Check the actual range before multiplying page by page size for SQL OFFSET.
        if ($total === 0 || $page - 1 > intdiv($total - 1, $perPage)) {
            return AdminUserResource::collection(new LengthAwarePaginator(
                [],
                $total,
                $perPage,
                $page,
                ['path' => $request->url(), 'pageName' => 'page'],
            ));
        }

        return AdminUserResource::collection(
            $query->paginate($perPage, ['*'], 'page', $page, $total),
        );
    }

    public function updateRole(UpdateUserRoleRequest $request, string $userId): AdminUserResource
    {
        $id = filter_var($userId, FILTER_VALIDATE_INT, ['options' => ['min_range' => 1]]);

        if ($id === false) {
            abort(Response::HTTP_NOT_FOUND);
        }

        /** @var User $actor */
        $actor = $request->user('api');

        return new AdminUserResource(
            $this->changeUserRoleHandler->handle(
                actorId: $actor->id,
                userId: $id,
                role: $request->getRole(),
            ),
        );
    }
}
