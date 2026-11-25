<?php

declare(strict_types=1);

namespace Tests\Feature;

use Illuminate\Support\Facades\Cache;
use PHPUnit\Framework\Attributes\WithEnvironmentVariable;
use Tests\TestCase;

#[WithEnvironmentVariable('SANCTUM_STATEFUL_DOMAINS')]
final class ProductionHttpConfigurationTest extends TestCase
{
    public function createApplication()
    {
        // phpunit.xml also sets APP_ENV in $_SERVER, which Laravel reads first.
        $previous = $_SERVER['APP_ENV'];
        $_SERVER['APP_ENV'] = $_ENV['APP_ENV'];

        try {
            return parent::createApplication();
        } finally {
            $_SERVER['APP_ENV'] = $previous;
        }
    }

    #[WithEnvironmentVariable('APP_ENV', 'production')]
    #[WithEnvironmentVariable('APP_URL', 'https://pizza.example.test')]
    public function test_public_origin_is_stateful_and_a_guest_receives_unauthorized(): void
    {
        self::assertSame('https://pizza.example.test', config('app.url'));
        self::assertSame(['pizza.example.test'], config('sanctum.stateful'));

        $this->getJson('https://pizza.example.test/api/me', [
            'X-Pizza-Client' => 'spa',
            'Referer' => 'https://pizza.example.test/',
        ])->assertUnauthorized();

        $this->getJson('https://pizza.example.test/api/me', [
            'X-Pizza-Client' => 'spa',
            'Origin' => 'https://other.example.test',
        ])->assertForbidden();
    }

    #[WithEnvironmentVariable('APP_ENV', 'production')]
    #[WithEnvironmentVariable('APP_URL', 'https://pizza.example.test')]
    #[WithEnvironmentVariable('TRUSTED_PROXY_IP', '192.0.2.10')]
    public function test_catalog_uses_https_only_when_the_forwarded_scheme_is_trusted(): void
    {
        Cache::put('products.attributes.v1.page.1', [
            'items' => [],
            'total' => 0,
            'current_page' => 1,
            'per_page' => 30,
        ]);

        $headers = [
            'X-Forwarded-Proto' => 'https',
            'X-Forwarded-Host' => 'other.example.test',
            'X-Forwarded-Port' => '444',
        ];

        $this->withServerVariables(['REMOTE_ADDR' => '192.0.2.10'])
            ->getJson('http://pizza.example.test/api/products?page=1', $headers)
            ->assertOk()
            ->assertJsonPath('meta.path', 'https://pizza.example.test/api/products')
            ->assertJsonPath('links.first', 'https://pizza.example.test/api/products?page=1');

        $this->withServerVariables(['REMOTE_ADDR' => '192.0.2.11'])
            ->getJson('http://pizza.example.test/api/products?page=1', $headers)
            ->assertOk()
            ->assertJsonPath('links.first', 'http://pizza.example.test/api/products?page=1');
    }

    #[WithEnvironmentVariable('APP_ENV', 'local')]
    #[WithEnvironmentVariable('APP_URL', 'http://localhost')]
    #[WithEnvironmentVariable('TRUSTED_PROXY_IP')]
    public function test_local_vite_origin_remains_stateful_over_http(): void
    {
        self::assertContains('localhost:5173', config('sanctum.stateful'));
        self::assertSame([], config('trustedproxy.proxies'));

        $this->getJson('http://localhost/api/me', [
            'X-Pizza-Client' => 'spa',
            'Origin' => 'http://localhost:5173',
        ])->assertUnauthorized();
    }
}
