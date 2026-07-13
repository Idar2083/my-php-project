<?php

declare(strict_types=1);

namespace App\Http\Controllers;

use App\Http\Controllers\Models\Product;
use App\Http\Requests\StoreProductRequest;
use App\Http\Requests\UpdateProductRequest;
use App\Http\Resources\ProductResource;
use Illuminate\Http\Resources\Json\AnonymousResourceCollection;
use Symfony\Component\HttpFoundation\Response;

class ProductController extends Controller
{
    public function index(): AnonymousResourceCollection
    {
        $products = Product::paginate(30);

        return ProductResource::collection($products);
    }

    public function store(StoreProductRequest $request): Response
    {
        $validate = $request->validated();

        $product = Product::create($validate);

        return (new ProductResource($product))->response()->setStatusCode(Response::HTTP_CREATED);
    }

    public function show(string $id): ProductResource
    {
        $product = Product::findOrFail($id);

        return new ProductResource($product);
    }

    public function update(UpdateProductRequest $request, string $id): ProductResource
    {
        $product = Product::findOrFail($id);
        $validate = $request->validated();

        $product->update($validate);

        return new ProductResource($product);
    }

    public function destroy(string $id): Response
    {
        $product = Product::findOrFail($id);
        $product->delete();

        return response()->json(null, Response::HTTP_NO_CONTENT);
    }
}
