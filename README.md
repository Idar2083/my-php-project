# Pizza Backend

## Stack

- PHP 8.4
- Laravel 13
- PostgreSQL
- Nginx
- Docker
- PHPUnit
- PHPStan + Larastan
- PHP CS Fixer
- Rector
- Gitlab CI

## Requirements

- Docker
- Docker compose

## Setup

```bash
cp .env.example .env
cp .env.example .env.local
```

Запустить проект:

```bash
make up
```

После запуска приложение будет доступно по адресу:

```
http://localhost:8080
```

(или через значение `NGINX_PORT` в `.env.local`)

## Useful commands

```bash
make logs
make bash
make cs
make cs-dr
make phpstan
make rector
make rector-dr
```

## Tests

```bash
php artisan test
```
