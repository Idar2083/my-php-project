<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class () extends Migration {
    public function up(): void
    {
        Schema::create('email_deliveries', function (Blueprint $table): void {
            $table->id();
            $table->uuid('event_id');
            $table->string('message_type');
            $table->string('recipient');
            $table->timestampTz('sent_at')->nullable();
            $table->timestampsTz();

            $table->unique([
                'event_id',
                'message_type',
            ]);
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('email_deliveries');
    }
};
