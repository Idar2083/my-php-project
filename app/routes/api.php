<?php

declare(strict_types=1);

use App\Modules\Auth\Presentation\Controllers\AuthController;
use App\Modules\Cart\Presentation\Controllers\CartController;
use App\Modules\Catalog\Presentation\Controllers\ProductController;
use App\Modules\Order\Presentation\Controllers\OrderController;
use App\Modules\Report\Presentation\Controllers\ReportController;
use Illuminate\Support\Facades\Route;

# Public routes
Route::get('/products', [ProductController::class, 'index']);
Route::get('/products/{id}', [ProductController::class, 'show']);

Route::post('/register', [AuthController::class, 'register']);
Route::post('/login', [AuthController::class, 'login']);

Route::get('/reports/{id}/download', [ReportController::class, 'download']);
Route::get('/reports/{id}', [ReportController::class, 'show']);
Route::post('/reports', [ReportController::class, 'store']);

# Admin routes
Route::middleware(['auth:api', 'admin'])->group(function (): void {
    Route::post('/products', [ProductController::class, 'store']);
    Route::put('/products/{id}', [ProductController::class, 'update']);
    Route::delete('/products/{id}', [ProductController::class, 'destroy']);
});

# Authenticated routes
Route::middleware(['auth:api'])->group(function (): void {
    Route::get('/me', [AuthController::class, 'me']);
    Route::post('/logout', [AuthController::class, 'logout']);

    Route::prefix('cart')->group(static function (): void {
        Route::get('/', [CartController::class, 'show']);
        Route::post('/items', [CartController::class, 'store']);
        Route::put('/items/{itemId}', [CartController::class, 'update']);
        Route::delete('/items/{itemId}', [CartController::class, 'destroy']);
        Route::delete('/', [CartController::class, 'clear']);
    });

    Route::prefix('orders')->group(static function (): void {
        Route::get('/', [OrderController::class, 'index']);
        Route::get('/{orderId}', [OrderController::class, 'show']);
        Route::post('/', [OrderController::class, 'store']);
    });
});
