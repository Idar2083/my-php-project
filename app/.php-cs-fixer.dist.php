<?php

declare(strict_types=1);

use PhpCsFixer\Config;
use PhpCsFixer\Finder;

$finder = Finder::create()
    ->in([
        __DIR__ . '/app',
        __DIR__ . '/bootstrap',
        __DIR__ . '/config',
        __DIR__ . '/database',
        __DIR__ . '/routes',
        __DIR__ . '/tests',
    ])
    ->exclude([
        'storage',
        'vendor',
    ]);

return (new Config())
    ->setRiskyAllowed(true)
    ->setUsingCache(true)
    ->setCacheFile(__DIR__ . '/var/php-cs-fixer.cache')
    ->setRules([
        '@PSR12' => true,

        '@PHP83Migration' => true,

        '@PHPUnit100Migration:risky' => true,

        'array_syntax' => [
            'syntax' => 'short',
        ],

        'ordered_imports' => [
            'sort_algorithm' => 'alpha',
        ],

        'no_unused_imports' => true,

        'single_quote' => true,

        'trailing_comma_in_multiline' => [
            'elements' => [
                'arrays',
                'arguments',
                'parameters',
                'match',
            ],
        ],

        'binary_operator_spaces' => [
            'default' => 'single_space',
        ],

        'concat_space' => [
            'spacing' => 'one',
        ],

        'class_attributes_separation' => [
            'elements' => [
                'const' => 'one',
                'method' => 'one',
                'property' => 'one',
            ],
        ],

        'declare_strict_types' => true,
        'strict_comparison' => true,
        'strict_param' => true,

        'global_namespace_import' => [
            'import_constants' => false,
            'import_functions' => false,
            'import_classes' => false,
        ],

        'method_chaining_indentation' => true,

        'no_superfluous_phpdoc_tags' => [
            'remove_inheritdoc' => true,
        ],

        'numeric_literal_separator' => true,
        'no_trailing_whitespace_in_string' => true,

        'ordered_class_elements' => [
            'order' => ['use_trait'],
        ],
    ])
    ->setFinder($finder);
