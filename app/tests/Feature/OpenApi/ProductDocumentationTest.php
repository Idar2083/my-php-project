<?php

declare(strict_types=1);

namespace Tests\Feature\OpenApi;

use App\Modules\Catalog\Domain\Models\Product;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Cache;
use OpenApi\Generator;
use Tests\TestCase;

final class ProductDocumentationTest extends TestCase
{
    use RefreshDatabase;

    public function test_empty_catalog_example_matches_real_response(): void
    {
        $document = $this->document();
        $examples = $document['paths']['/api/products']['get']['responses']['200']['content']['application/json']['examples'];

        $this->assertSame(
            $examples['emptyCatalog']['value'],
            $this->normalizeUrls($this->getJson('/api/products')->assertOk()->json()),
        );
    }

    public function test_single_product_example_matches_real_response(): void
    {
        $document = $this->document();
        $examples = $document['paths']['/api/products']['get']['responses']['200']['content']['application/json']['examples'];
        $product = Product::factory()->create();
        $expected = $examples['singleProduct']['value'];
        $expected['data'][0]['id'] = $product->id;

        $this->assertEquals(
            $expected,
            $this->normalizeUrls($this->getJson('/api/products')->assertOk()->json()),
        );
    }

    public function test_pagination_and_nullable_fields_match_documented_contract(): void
    {
        $products = Product::factory()->count(31)->create(['description' => null]);

        $response = $this->getJson('/api/products?page=2')->assertOk();

        $response
            ->assertJsonCount(1, 'data')
            ->assertJsonPath('data.0.id', $products->last()->id)
            ->assertJsonPath('data.0.description', null)
            ->assertJsonPath('data.0.weight', '0.550')
            ->assertJsonPath('meta.current_page', 2)
            ->assertJsonPath('meta.per_page', 30)
            ->assertJsonPath('meta.from', 31)
            ->assertJsonPath('meta.to', 31)
            ->assertJsonPath('meta.total', 31)
            ->assertJsonPath('links.next', null);

        $this->assertIsNumeric($response->json('data.0.price'));
        $this->assertIsNotString($response->json('data.0.price'));

        $this->getJson('/api/products?page=3')->assertOk()
            ->assertJsonPath('data', [])
            ->assertJsonPath('meta.from', null)
            ->assertJsonPath('meta.to', null);

        $document = $this->document();
        $schemas = $document['components']['schemas'];
        $this->assertTrue($schemas['Product']['properties']['description']['nullable']);
        $this->assertSame('string', $schemas['Product']['properties']['weight']['type']);
        $this->assertSame('number', $schemas['Product']['properties']['price']['type']);
        $this->assertNotContains('page', $schemas['ProductPaginationLink']['required']);
    }

    public function test_document_has_public_operation_and_resolvable_references(): void
    {
        $document = $this->document();

        $this->assertSame('3.0.3', $document['openapi']);
        $this->assertSame('/', $document['servers'][0]['url']);
        $this->assertNull(config('l5-swagger.defaults.paths.base'));
        $this->assertSame([
            app_path('Http/OpenApi'),
            app_path('Modules/Catalog/Presentation/OpenApi'),
            app_path('Modules/Cart/Presentation/OpenApi'),
            app_path('Modules/Order/Presentation/OpenApi'),
        ], config('l5-swagger.documentations.default.paths.annotations'));
        $this->assertArrayHasKey('/api/products', $document['paths']);
        $operation = $document['paths']['/api/products']['get'];
        $this->assertSame('listProducts', $operation['operationId']);
        $schemas = (new \ReflectionClass(\App\Modules\Catalog\Presentation\OpenApi\ProductSchemas::class))
            ->getAttributes(\OpenApi\Attributes\Schema::class);
        $names = array_map(static fn (\ReflectionAttribute $attribute): string => $attribute->newInstance()->schema, $schemas);
        $this->assertSame($names, array_values(array_unique($names)));
        foreach ($names as $name) {
            $this->assertArrayHasKey($name, $document['components']['schemas']);
        }
        $this->assertSame([], $operation['security']);
        $this->assertSame(['200'], array_map('strval', array_keys($operation['responses'])));
        $this->assertSame(['page'], array_column($operation['parameters'], 'name'));
        $this->assertArrayNotHasKey('minimum', $operation['parameters'][0]['schema']);

        $walk = function (array $node) use (&$walk, $document): void {
            foreach ($node as $key => $value) {
                if ($key === '$ref') {
                    $this->assertStringStartsWith('#/', $value);
                    $target = $document;
                    foreach (explode('/', substr($value, 2)) as $part) {
                        $this->assertArrayHasKey($part, $target);
                        $target = $target[$part];
                    }
                } elseif (is_array($value)) {
                    $walk($value);
                }
            }
        };
        $walk($document);
    }

    protected function setUp(): void
    {
        parent::setUp();

        Cache::flush();
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

    /**
     * Remove only the dynamic request origin from pagination URLs.
     *
     * @param array<string, mixed> $response
     * @return array<string, mixed>
     */
    private function normalizeUrls(array $response): array
    {
        array_walk_recursive($response, static function (&$value): void {
            if (is_string($value) && str_starts_with($value, 'http://localhost/')) {
                $value = substr($value, strlen('http://localhost'));
            }
        });

        return $response;
    }
}
