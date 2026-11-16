<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class () extends Migration {
    public function up(): void
    {
        Schema::table('outbox_events', function (Blueprint $table): void {
            $table->timestampTz('processing_at')->nullable();
            $table->uuid('processing_token')->nullable();

            $table->index([
                'published_at',
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
                'processing_at',
                'occurred_at',
            ]);

            $table->dropColumn([
                'processing_at',
                'processing_token',
            ]);
        });
    }
};
