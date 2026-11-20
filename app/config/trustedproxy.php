<?php

declare(strict_types=1);

$proxy = filter_var(env('TRUSTED_PROXY_IP', ''), FILTER_VALIDATE_IP);

return [
    'proxies' => $proxy === false ? [] : [$proxy],
];
