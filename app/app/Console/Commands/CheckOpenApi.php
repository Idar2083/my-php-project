<?php

declare(strict_types=1);

namespace App\Console\Commands;

use App\Http\OpenApi\Support\StrictGeneratorFactory;
use Illuminate\Console\Command;
use L5Swagger\ConfigFactory;
use OpenApi\Analysis;
use OpenApi\Annotations\OpenApi;
use OpenApi\Context;
use OpenApi\Serializer;

final class CheckOpenApi extends Command
{
    protected $signature = 'openapi:check {file? : JSON file; defaults to the configured documentation file}';

    protected $description = 'Validate generated OpenAPI and required pizza API operations';

    public function handle(ConfigFactory $configFactory): int
    {
        try {
            $config = $configFactory->documentationConfig(config('l5-swagger.default'));
            $file = $this->argument('file') ?? $config['paths']['docs'] . '/' . $config['paths']['docs_json'];
            $json = file_get_contents($file);
            if ($json === false) {
                throw new \RuntimeException('Cannot read OpenAPI JSON');
            }
            $document = json_decode($json, true, 512, JSON_THROW_ON_ERROR);
            if (!is_array($document) || ($document['openapi'] ?? null) !== '3.0.3') {
                throw new \RuntimeException('Expected OpenAPI 3.0.3');
            }

            $context = new Context([
                'generated' => true,
                'logger' => (new StrictGeneratorFactory())->create()->getLogger(),
            ]);
            $annotation = (new Serializer())->deserialize($json, OpenApi::class, $context);
            if (!(new Analysis([$annotation], $context))->validate()) {
                throw new \RuntimeException('OpenAPI validation failed');
            }

            foreach (['/api/products' => 'get', '/api/cart/items' => 'post', '/api/orders' => 'post'] as $path => $method) {
                if (!isset($document['paths'][$path][$method])) {
                    throw new \RuntimeException('Missing operation: ' . $method . ' ' . $path);
                }
            }
            $ids = [];
            foreach ($document['paths'] as $path => $operations) {
                if (str_contains($path, '/api/api')) {
                    throw new \RuntimeException('Duplicate API prefix: ' . $path);
                }
                foreach (['get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'trace'] as $method) {
                    if (!isset($operations[$method])) {
                        continue;
                    }
                    $id = $operations[$method]['operationId'] ?? null;
                    if (!is_string($id) || $id === '' || in_array($id, $ids, true)) {
                        throw new \RuntimeException('Missing or duplicate operationId');
                    }
                    $ids[] = $id;
                }
            }
            $this->checkReferences($document, $document);
            $this->info('OpenAPI 3.0.3 is valid; required operations, operationIds and references checked.');

            return self::SUCCESS;
        } catch (\Throwable $exception) {
            $this->error($exception->getMessage());

            return self::FAILURE;
        }
    }

    /**
     * @param array<mixed> $node
     * @param array<mixed> $document
     */
    private function checkReferences(array $node, array $document): void
    {
        foreach ($node as $key => $value) {
            if ($key === '$ref') {
                if (!is_string($value) || !str_starts_with($value, '#/')) {
                    throw new \RuntimeException('Only local references are supported');
                }
                $target = $document;
                foreach (explode('/', substr($value, 2)) as $part) {
                    $part = str_replace(['~1', '~0'], ['/', '~'], $part);
                    if (!is_array($target) || !array_key_exists($part, $target)) {
                        throw new \RuntimeException('Unresolved reference: ' . $value);
                    }
                    $target = $target[$part];
                }
            } elseif (is_array($value)) {
                $this->checkReferences($value, $document);
            }
        }
    }
}
