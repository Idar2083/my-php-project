<?php

declare(strict_types=1);

namespace App\Modules\Auth\Infrastructure\Console;

use App\Modules\Auth\Domain\Enums\UserRole;
use App\Modules\Auth\Domain\Models\User;
use Illuminate\Console\Command;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rules\Password;

final class CreateAdmin extends Command
{
    protected $signature = 'auth:create-admin';

    protected $description = 'Create an administrator using an interactive secret prompt';

    public function handle(): int
    {
        if (!$this->input->isInteractive()) {
            $this->error('An interactive terminal is required.');

            return self::FAILURE;
        }

        $name = $this->ask('Name');
        $email = $this->ask('Email');
        $password = $this->secret('Password', false);
        $confirmation = $this->secret('Confirm password', false);
        $validator = Validator::make([
            'name' => $name, 'email' => $email, 'password' => $password,
            'password_confirmation' => $confirmation,
        ], [
            'name' => ['required', 'string', 'max:255'],
            'email' => ['required', 'email', 'max:255', 'unique:users,email'],
            'password' => ['required', 'string', 'max:4096', 'confirmed', Password::min(12)->mixedCase()->numbers()->symbols()],
        ]);
        if ($validator->fails()) {
            $this->error('Invalid input, duplicate email, or passwords do not match.');

            return self::FAILURE;
        }

        $user = new User();
        $user->name = $name;
        $user->email = $email;
        $user->password = $password;
        $user->role = UserRole::ADMIN;
        $user->save();
        $this->info('Administrator created.');

        return self::SUCCESS;
    }
}
