<?php

declare(strict_types=1);

use Illuminate\Support\Facades\Schedule;

Schedule::command('reports:generate-daily')
    ->dailyAt('02:00')
    ->withoutOverlapping();
