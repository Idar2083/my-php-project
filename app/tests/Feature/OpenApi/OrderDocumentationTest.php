<?php

declare(strict_types=1);

namespace Tests\Feature\OpenApi;

use App\Modules\Auth\Domain\Models\User;
use App\Modules\Cart\Domain\Models\Cart;
use App\Modules\Cart\Domain\Models\CartItem;
use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use OpenApi\Generator;
use Tests\TestCase;
use Tymon\JWTAuth\Facades\JWTAuth;

final class OrderDocumentationTest extends TestCase
{
    use RefreshDatabase;

    public function test_specification_has_request_response_and_security_contract(): void
    {
        $document = $this->document();
        $operation = $document['paths']['/api/orders']['post'];
        $this->assertSame('createOrder', $operation['operationId']);
        $this->assertSame([['bearerAuth' => []]], $operation['security']);
        $this->assertSame('bearer', $document['components']['securitySchemes']['bearerAuth']['scheme']);
        $this->assertSame(['201', '401', '422'], array_map('strval', array_keys($operation['responses'])));
        $this->assertTrue($operation['requestBody']['required']);
        $this->assertSame('#/components/schemas/CreateOrderRequest', $operation['requestBody']['content']['application/json']['schema']['$ref']);
        $schemas = $document['components']['schemas'];
        $request = $schemas['CreateOrderRequest'];
        $this->assertSame(['region', 'city', 'street', 'house', 'postal_code', 'delivery_method'], $request['required']);
        foreach (['region', 'city', 'street', 'house', 'postal_code', 'delivery_method'] as $field) {
            $this->assertSame(1, $request['properties'][$field]['minLength']);
        }
        foreach (['region', 'city', 'street', 'house', 'postal_code', 'entrance', 'apartment'] as $field) {
            $this->assertSame('string', $request['properties'][$field]['type']);
            $this->assertSame(255, $request['properties'][$field]['maxLength']);
        }
        foreach (['entrance', 'apartment'] as $field) {
            $this->assertNotContains($field, $request['required']);
            $this->assertArrayNotHasKey('minLength', $request['properties'][$field]);
            $this->assertTrue($request['properties'][$field]['nullable']);
            $this->assertTrue($schemas['OrderAddress']['properties'][$field]['nullable']);
        }
        $this->assertArrayNotHasKey('enum', $request['properties']['delivery_method']);
        $this->assertArrayNotHasKey('maxLength', $request['properties']['delivery_method']);
        $this->assertSame('#/components/schemas/Product', $schemas['OrderItem']['properties']['product']['$ref']);
        $this->assertSame('string', $schemas['OrderItem']['properties']['price']['type']);
        $this->assertSame('string', $schemas['CreatedOrder']['properties']['total_price']['type']);
        $this->assertSame(['created'], $schemas['CreatedOrder']['properties']['status']['enum']);
    }

    public function test_success_example_matches_http_response_and_clears_cart(): void
    {
        $this->travelTo(now()->setDate(2_026, 10, 9)->setTime(12, 0));
        $cart = $this->cart(2);
        $operation = $this->document()['paths']['/api/orders']['post'];
        $response = $this->postJson('/api/orders', $this->request())->assertCreated();
        $expected = $operation['responses']['201']['content']['application/json']['example'];
        $expected['data']['id'] = $response->json('data.id');
        $expected['data']['items'][0]['id'] = $response->json('data.items.0.id');
        $expected['data']['items'][0]['product_id'] = $cart->items->first()->product_id;
        $expected['data']['items'][0]['product']['id'] = $cart->items->first()->product_id;
        $response->assertExactJson($expected);
        $this->assertDatabaseCount('cart_items', 0);
        $this->assertDatabaseHas('carts', ['id' => $cart->id]);
        $this->postJson('/api/orders', $this->request())->assertUnprocessable()
            ->assertExactJson($operation['responses']['422']['content']['application/json']['examples']['emptyCart']['value']);
    }

    public function test_optional_address_fields_and_unrestricted_delivery_method(): void
    {
        $this->cart(30);
        $request = $this->request();
        unset($request['entrance'], $request['apartment']);
        $request['delivery_method'] = 'custom-method';
        $request['total_price'] = 1;
        $request['items'] = [];
        $this->postJson('/api/orders', $request)->assertCreated()
            ->assertJsonPath('data.address.entrance', null)->assertJsonPath('data.address.apartment', null)
            ->assertJsonPath('data.delivery_method', 'custom-method')->assertJsonPath('data.total_price', '15000.00')
            ->assertJsonPath('data.items.0.quantity', 30);
    }

    public function test_summed_quantity_limit_example_matches_http_response(): void
    {
        $cart = $this->cart(15);
        CartItem::factory()->for($cart)->for(Product::factory()->create())->create(['quantity' => 16]);
        $example = $this->document()['paths']['/api/orders']['post']['responses']['422']['content']['application/json']['examples']['quantityLimit']['value'];
        $this->postJson('/api/orders', $this->request())->assertUnprocessable()->assertExactJson($example);
        $this->assertDatabaseCount('orders', 0);
        $this->assertDatabaseCount('cart_items', 2);
    }

    public function test_missing_and_empty_cart_examples_match_http_response(): void
    {
        $user = $this->authenticate();
        $example = $this->document()['paths']['/api/orders']['post']['responses']['422']['content']['application/json']['examples']['emptyCart']['value'];
        $this->postJson('/api/orders', $this->request())->assertUnprocessable()->assertExactJson($example);
        Cart::factory()->for($user)->create();
        $this->postJson('/api/orders', $this->request())->assertUnprocessable()->assertExactJson($example);
    }

    public function test_unauthenticated_examples_match_http_response(): void
    {
        $example = $this->document()['paths']['/api/orders']['post']['responses']['401']['content']['application/json']['example'];
        $this->postJson('/api/orders', $this->request())->assertUnauthorized()->assertExactJson($example);
        $this->withHeader('Authorization', 'Bearer invalid-token')->postJson('/api/orders', $this->request())
            ->assertUnauthorized()->assertExactJson($example);
    }

    public function test_required_string_and_length_validation(): void
    {
        $this->cart(2);
        $required = $this->document()['components']['schemas']['CreateOrderRequest']['required'];
        $this->postJson('/api/orders', [])->assertUnprocessable()->assertJsonValidationErrors($required);
        foreach ($required as $field) {
            foreach (['', '   '] as $invalid) {
                $this->postJson('/api/orders', array_replace($this->request(), [$field => $invalid]))
                    ->assertUnprocessable()->assertJsonValidationErrors($field);
            }
        }
        foreach (['region', 'city', 'street', 'house', 'postal_code', 'entrance', 'apartment'] as $field) {
            foreach ([str_repeat('a', 256), 1] as $invalid) {
                $this->postJson('/api/orders', array_replace($this->request(), [$field => $invalid]))
                    ->assertUnprocessable()->assertJsonValidationErrors($field);
            }
        }
        $this->postJson('/api/orders', array_replace($this->request(), ['delivery_method' => 1]))
            ->assertUnprocessable()->assertJsonValidationErrors('delivery_method');
        $this->assertDatabaseCount('orders', 0);
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

    private function cart(int $quantity): Cart
    {
        $cart = Cart::factory()->for($this->authenticate())->create();
        CartItem::factory()->for($cart)->for(Product::factory()->create())->create(['quantity' => $quantity]);

        return $cart->load('items');
    }

    private function request(): array
    {
        return $this->document()['paths']['/api/orders']['post']['requestBody']['content']['application/json']['example'];
    }

    private function document(): array
    {
        $document = (new Generator())->generate(config('l5-swagger.documentations.default.paths.annotations'));
        $this->assertNotNull($document);
        $this->assertTrue($document->validate());

        return json_decode($document->toJson(), true, 512, JSON_THROW_ON_ERROR);
    }
}
