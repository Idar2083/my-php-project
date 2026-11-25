<?php

declare(strict_types=1);

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Contracts\Console\Kernel;

require __DIR__ . '/../../vendor/autoload.php';
$app = require __DIR__ . '/../../bootstrap/app.php';
$app->make(Kernel::class)->bootstrap();
if (!$app->environment('testing') || config('database.connections.pgsql.database') !== 'pizza_ui_test'
    || getenv('UI_API_FIXTURE') !== '1') {
    throw new RuntimeException('This fixture is restricted to the isolated pizza_ui_test database.');
}
$password = getenv('UI_TEST_ADMIN_PASSWORD');
if (!is_string($password) || strlen($password) < 12) {
    throw new RuntimeException('An ephemeral test administrator password is required.');
}
$admin = new User();
$admin->name = 'UI test operator';
$admin->email = 'ui-admin@example.test';
$admin->password = $password;
$admin->role = UserRole::ADMIN;
$admin->save();
foreach (['pizza' => 'UI integration pizza', 'drink' => 'UI integration drink'] as $category => $name) {
    Product::query()->create([
        'name' => $name, 'price' => '12.50', 'category' => $category,
        'weight' => '0.500', 'description' => 'Isolated UI/API fixture',
    ]);
}
echo "Isolated UI fixtures ready.\n";
