<?php

declare(strict_types=1);

namespace Tests\Feature\OpenApi;

use App\Http\OpenApi\ErrorSchemas;
use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Application\Services\CartService;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Cart\Presentation\OpenApi\CartSchemas;
use App\Modules\Catalog\Domain\Models\Product;
use App\Modules\Catalog\Presentation\OpenApi\ProductSchemas;
use App\Modules\Order\Presentation\OpenApi\OrderSchemas;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Mockery\MockInterface;
use OpenApi\Attributes\Schema;
use OpenApi\Generator;
use PHPUnit\Framework\Attributes\DataProvider;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class CartDocumentationTest extends TestCase
{
    use RefreshDatabase;

    public function test_operation_schemas_security_and_unique_names(): void
    {
        $document = $this->document();
        $operation = $document['paths']['/api/cart/items']['post'];
        $this->assertSame('addCartItem', $operation['operationId']);
        $this->assertSame([['bearerAuth' => []]], $operation['security']);
        $security = $document['components']['securitySchemes']['bearerAuth'];
        $this->assertSame('http', $security['type']);
        $this->assertSame('bearer', $security['scheme']);
        $this->assertSame('JWT', $security['bearerFormat']);
        $this->assertSame('/', $document['servers'][0]['url']);
        $this->assertArrayNotHasKey('/api/cart/add', $document['paths']);
        $this->assertSame(['200', '401', '404', '422'], array_map('strval', array_keys($operation['responses'])));
        $this->assertTrue($operation['requestBody']['required']);
        $this->assertSame('#/components/schemas/AddCartItemRequest', $operation['requestBody']['content']['application/json']['schema']['$ref']);
        $schemas = $document['components']['schemas'];
        $request = $schemas['AddCartItemRequest'];
        $this->assertSame(['product_id', 'quantity'], $request['required']);
        $this->assertSame('integer', $request['properties']['product_id']['type']);
        $this->assertSame('integer', $request['properties']['quantity']['type']);
        $this->assertSame(1, $request['properties']['quantity']['minimum']);
        $this->assertArrayNotHasKey('maximum', $request['properties']['quantity']);
        $this->assertSame('#/components/schemas/CartResponse', $operation['responses']['200']['content']['application/json']['schema']['$ref']);
        $this->assertSame(['id', 'user_id', 'items'], $schemas['Cart']['required']);
        $this->assertSame(['id', 'product_id', 'quantity', 'product'], $schemas['CartItem']['required']);
        $this->assertSame('#/components/schemas/Product', $schemas['CartItem']['properties']['product']['$ref']);

        $names = [];
        foreach ([ProductSchemas::class, CartSchemas::class, OrderSchemas::class, ErrorSchemas::class] as $class) {
            foreach ((new \ReflectionClass($class))->getAttributes(Schema::class) as $attribute) {
                $names[] = $attribute->newInstance()->schema;
            }
        }
        $this->assertSame($names, array_values(array_unique($names)));
        $this->assertCount(count($names), $schemas);
        $ids = [];
        foreach ($document['paths'] as $path) {
            foreach ($path as $definition) {
                $ids[] = $definition['operationId'];
            }
        }
        $this->assertSame($ids, array_values(array_unique($ids)));
    }

    public function test_success_example_matches_first_and_repeated_addition(): void
    {
        $product = Product::factory()->create();
        $user = $this->authenticate();
        $document = $this->document();
        $operation = $document['paths']['/api/cart/items']['post'];
        $request = $operation['requestBody']['content']['application/json']['example'];
        $request['product_id'] = $product->id;
        $response = $this->postJson('/api/cart/items', $request)->assertOk();
        $expected = $operation['responses']['200']['content']['application/json']['example'];
        $cart = Cart::query()->where('user_id', $user->id)->with('items')->firstOrFail();
        $expected['data']['id'] = $cart->id;
        $expected['data']['user_id'] = $user->id;
        $expected['data']['items'][0]['id'] = $cart->items->first()->id;
        $expected['data']['items'][0]['product_id'] = $product->id;
        $expected['data']['items'][0]['product']['id'] = $product->id;
        $response->assertExactJson($expected);

        $this->postJson('/api/cart/items', ['product_id' => $product->id, 'quantity' => 3])
            ->assertOk()->assertJsonCount(1, 'data.items')->assertJsonPath('data.items.0.quantity', 5);
    }

    public function test_missing_and_invalid_tokens_match_documented_401(): void
    {
        $document = $this->document();
        $expected = $document['paths']['/api/cart/items']['post']['responses']['401']['content']['application/json']['example'];
        $this->postJson('/api/cart/items', [])->assertUnauthorized()->assertExactJson($expected);
        $this->withHeader('Authorization', 'Bearer invalid-token')
            ->postJson('/api/cart/items', [])->assertUnauthorized()->assertExactJson($expected);
        $this->withHeader('Accept-Language', 'ru')->postJson('/api/cart/items', [])
            ->assertUnauthorized()->assertExactJson(['message' => 'Необходима аутентификация.']);
    }

    #[DataProvider('businessErrors')]
    public function test_business_error_examples_match_real_responses(string $category, int $quantity, string $example): void
    {
        $this->authenticate();
        $product = Product::factory()->create(['category' => $category]);
        $document = $this->document();
        $expected = $document['paths']['/api/cart/items']['post']['responses']['422']['content']['application/json']['examples'][$example]['value'];
        $this->postJson('/api/cart/items', ['product_id' => $product->id, 'quantity' => $quantity])
            ->assertUnprocessable()->assertExactJson($expected);
    }

    /** @return array<string, array{string, int, string}> */
    public static function businessErrors(): array
    {
        return [
            'pizza limit' => ['pizza', 11, 'pizzaLimit'],
            'drink limit' => ['drink', 21, 'drinkLimit'],
            'unsupported category' => ['dessert', 1, 'unsupportedCategory'],
            'case-sensitive category' => ['Pizza', 1, 'unsupportedCategory'],
        ];
    }

    public function test_category_totals_are_shared_across_different_products(): void
    {
        $this->authenticate();
        foreach (['pizza' => 10, 'drink' => 20] as $category => $limit) {
            $first = Product::factory()->create(['category' => $category]);
            $second = Product::factory()->create(['category' => $category]);
            $this->postJson('/api/cart/items', ['product_id' => $first->id, 'quantity' => $limit - 1])->assertOk();
            $this->postJson('/api/cart/items', ['product_id' => $second->id, 'quantity' => 1])->assertOk();
            $this->postJson('/api/cart/items', ['product_id' => $second->id, 'quantity' => 1])
                ->assertUnprocessable()->assertJsonValidationErrors('quantity');
        }
    }

    public function test_request_validation_returns_documented_error_structure(): void
    {
        $this->authenticate();
        $product = Product::factory()->create();
        foreach ([
            [[], ['product_id', 'quantity']],
            [['product_id' => $product->id, 'quantity' => 0], ['quantity']],
            [['product_id' => 'invalid', 'quantity' => 1.5], ['product_id', 'quantity']],
            [['product_id' => $product->id + 1, 'quantity' => 1], ['product_id']],
        ] as [$request, $fields]) {
            $response = $this->postJson('/api/cart/items', $request)->assertUnprocessable()
                ->assertJsonValidationErrors($fields)->assertJsonStructure(['message', 'errors']);
            $this->assertIsString($response->json('message'));
            foreach ($fields as $field) {
                $this->assertIsString($response->json('errors.' . $field . '.0'));
            }
        }
    }

    public function test_product_disappearing_after_validation_returns_404(): void
    {
        $this->authenticate();
        $product = Product::factory()->create();
        // Simulate the deletion between request validation and the real service read.
        $this->mock(CartService::class, static function (MockInterface $mock) use ($product): void {
            $mock->shouldReceive('addItem')->once()->andReturnUsing(
                static function (User $user, int $productId, int $quantity) use ($product): Cart {
                    $product->delete();

                    return (new CartService())->addItem($user, $productId, $quantity);
                },
            );
        });
        $response = $this->postJson('/api/cart/items', ['product_id' => $product->id, 'quantity' => 1])
            ->assertNotFound()->assertJsonStructure(['message']);
        $this->assertIsString($response->json('message'));
    }

    protected function setUp(): void
    {
        parent::setUp();

        $this->withHeader('Accept-Language', 'en');
    }

    private function authenticate(): User
    {
        $user = User::factory()->create();
        $this->withHeader('Authorization', 'Bearer ' . JWTAuth::fromUser($user));

        return $user;
    }

    /** @return array<string, mixed> */
    private function document(): array
    {
        $document = (new Generator())->setVersion('3.0.3')->generate(
            config('l5-swagger.documentations.default.paths.annotations'),
        );
        $this->assertNotNull($document);
        $this->assertTrue($document->validate());

        return json_decode($document->toJson(), true, flags: JSON_THROW_ON_ERROR);
    }
}
