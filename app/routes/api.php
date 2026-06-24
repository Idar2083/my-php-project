<?php

use Illuminate\Http\Request;
use Illuminate\Support\Facades\Route;
use App\Http\Controllers\ProductController;
use App\Http\Controllers\AuthController;

Route::get('/user', function (Request $request) {
    return $request->user();
})->middleware('auth:sanctum');

Route::get('/products', [ProductController::class, 'index']);
Route::get('/products/{id}', [ProductController::class, 'show']);
Route::post('/products', [ProductController::class, 'store'])
    ->middleware('auth:api', 'admin');
Route::put('/products/{id}', [ProductController::class, 'update'])
    ->middleware('auth:api', 'admin');
Route::delete('/products/{id}', [ProductController::class, 'destroy'])
    ->middleware('auth:api', 'admin');
Route::post('/register', [AuthController::class, 'register']);
Route::post('/login', [AuthController::class, 'login']);
Route::get('/me', [AuthController::class, 'me'])
    ->middleware('auth:api');
Route::post('/logout', [AuthController::class, 'logout'])
    ->middleware('auth:api');
