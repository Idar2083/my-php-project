<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class () extends Migration {
    public function up(): void
    {
        Schema::table('order_items', function (Blueprint $table): void {
            $table->string('product_name')->nullable();
        });

        DB::statement('
            UPDATE order_items
            SET product_name = products.name
            FROM products
            WHERE products.id = order_items.product_id
        ');

        Schema::table('order_items', function (Blueprint $table): void {
            $table->string('product_name')->nullable(false)->change();
        });
    }

    public function down(): void
    {
        Schema::table('order_items', function (Blueprint $table): void {
            $table->dropColumn('product_name');
        });
    }
};
