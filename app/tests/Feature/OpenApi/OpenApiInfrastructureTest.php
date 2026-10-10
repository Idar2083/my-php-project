<?php

declare(strict_types=1);

namespace Tests\Feature\OpenApi;

use Illuminate\Support\Facades\File;
use Symfony\Component\Process\Process;
use Tests\TestCase;

final class OpenApiInfrastructureTest extends TestCase
{
    private string $directory;

    public function test_clean_generation_and_documentation_routes(): void
    {
        $this->assertFileDoesNotExist($this->directory . '/api-docs.json');
        $this->artisan('l5-swagger:generate')->assertSuccessful();
        $this->artisan('openapi:check')->assertSuccessful();
        $this->get('/api/doc')->assertOk()->assertSee('SwaggerUIBundle', false);
        $this->get('/docs')->assertOk()->assertJsonPath('openapi', '3.0.3');
        $this->get('/docs/asset/swagger-ui.css')->assertOk();
        $this->get('/docs/asset/swagger-ui-bundle.js')->assertOk();
    }

    public function test_checker_rejects_invalid_documents(): void
    {
        $this->artisan('l5-swagger:generate')->assertSuccessful();
        $file = $this->directory . '/api-docs.json';
        $document = json_decode(File::get($file), true, flags: JSON_THROW_ON_ERROR);
        $invalid = [];
        $invalid[] = ['{', 'Syntax error'];
        $changed = $document;
        $changed['openapi'] = '3.1.0';
        $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), 'Expected OpenAPI 3.0.3'];
        $changed = $document;
        unset($changed['info']);
        $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), 'Required @OA\\Info() not found'];
        $changed = $document;
        unset($changed['info']['title']);
        $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), 'Missing required field "title"'];
        $changed = $document;
        unset($changed['paths']['/api/orders']['post']['responses']);
        $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), '@OA\\Post() requires at least one @OA\\Response()'];
        $changed = $document;
        unset($changed['components']['schemas']['ProductPage']['properties']['data']['items']);
        $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), '@OA\\Items() is required'];
        foreach (['/api/products', '/api/cart/items', '/api/orders'] as $path) {
            $changed = $document;
            unset($changed['paths'][$path]);
            $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), 'Missing operation:'];
        }
        $changed = $document;
        $changed['paths']['/api/orders']['post']['operationId'] = $changed['paths']['/api/products']['get']['operationId'];
        $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), 'operationId must be unique'];
        $changed = $document;
        unset($changed['paths']['/api/orders']['post']['operationId']);
        $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), 'Missing or duplicate operationId'];
        $changed = $document;
        $changed['paths']['/api/products']['get']['responses']['200'] = ['$ref' => '#/components/responses/Missing'];
        $invalid[] = [json_encode($changed, JSON_THROW_ON_ERROR), '#/components/responses/Missing'];
        foreach ($invalid as [$json, $message]) {
            File::put($file, $json);
            $this->artisan('openapi:check')->expectsOutputToContain($message)->assertExitCode(1);
        }
    }

    public function test_generator_rejects_unresolved_references(): void
    {
        $this->assertGeneratorFails("#[\\OpenApi\\Attributes\\Get(path: '/broken', responses: [new \\OpenApi\\Attributes\\Response(response: 200, ref: '#/components/responses/Missing')])]");
    }

    public function test_generator_rejects_invalid_operations(): void
    {
        $this->assertGeneratorFails("#[\\OpenApi\\Attributes\\Get(path: '/broken')]");
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->directory = sys_get_temp_dir() . '/pizza-openapi-' . bin2hex(random_bytes(8));
        File::makeDirectory($this->directory);
        config(['l5-swagger.defaults.paths.docs' => $this->directory]);
    }

    protected function tearDown(): void
    {
        File::deleteDirectory($this->directory);
        parent::tearDown();
    }

    private function assertGeneratorFails(string $attribute): void
    {
        $fixture = $this->directory . '/Broken.php';
        $class = 'Broken' . bin2hex(random_bytes(8));
        File::put($fixture, '<?php ' . $attribute . ' final class ' . $class . ' {}');
        $paths = [
            app_path('Http/OpenApi/ApiDocument.php'),
            $fixture,
        ];
        $script = 'require "vendor/autoload.php"; $app = require "bootstrap/app.php";'
            . '$kernel = $app->make(\\Illuminate\\Contracts\\Console\\Kernel::class); $kernel->bootstrap();'
            . 'config(["l5-swagger.documentations.default.paths.annotations" => ' . var_export($paths, true) . ','
            . '"l5-swagger.defaults.paths.docs" => ' . var_export($this->directory, true) . ']);'
            . 'exit($app->handleCommand(new \\Symfony\\Component\\Console\\Input\\ArrayInput(["command" => "l5-swagger:generate"])));';
        $process = new Process([PHP_BINARY, '-r', $script], base_path());
        $process->run();
        $this->assertSame(1, $process->getExitCode(), $process->getOutput() . $process->getErrorOutput());
        $this->assertFileDoesNotExist($this->directory . '/api-docs.json');
    }
}
