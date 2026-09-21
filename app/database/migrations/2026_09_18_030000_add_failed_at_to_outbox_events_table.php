<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class () extends Migration {
    public function up(): void
    {
        Schema::table('outbox_events', function (Blueprint $table): void {
            $table->timestampTz('failed_at')->nullable();

            $table->index([
                'published_at',
                'failed_at',
                'processing_at',
                'occurred_at',
            ]);
        });
    }

    public function down(): void
    {
        Schema::table('outbox_events', function (Blueprint $table): void {
            $table->dropIndex([
                'published_at',
                'failed_at',
                'processing_at',
                'occurred_at',
            ]);

            $table->dropColumn('failed_at');
        });
    }
};
