<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class () extends Migration {
    public function up(): void
    {
        Schema::create('products', function (Blueprint $table) {
            $table->id();
            $table->timestamps();
            $table->string('name');
            $table->text('description')->nullable();
            $table->string('category');
            $table->decimal('weight', total: 5, places: 3);
            $table->unsignedInteger('price');
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('products');
    }
};
