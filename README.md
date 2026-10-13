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

## Frontend (этап 12.1)

Минимальный Vue 3 + Vite SPA находится в `frontend/`. Он получает товары из
`GET /api/products`, отображает загрузку, каталог, пустой результат или ошибку
с повторной загрузкой. Пагинация использует метаданные ответа API.

`make up` запускает также frontend: http://localhost:5173.
Для запуска только frontend при уже работающем backend:

```bash
docker compose --env-file .env --env-file .env.local --profile frontend up -d --build --wait frontend
```

В корневом `.env.local` можно задать `FRONTEND_PORT=5173` и
`VITE_API_BASE_URL=/api`. По умолчанию браузер обращается к тому же origin,
а Vite проксирует `/api` в backend nginx: CORS-настройки не требуются.
Профиль `frontend` предназначен для разработки; production-команда его не включает.

Для запуска без Docker (Node.js 24+):

```bash
cd frontend
cp .env.example .env.local
# В .env.local задать API_PROXY_TARGET=http://localhost:8080
npm ci
npm run dev
```

`VITE_API_BASE_URL` — публичная переменная, включающая `/api`; секреты в неё
помещать нельзя. При абсолютном URL другого origin backend должен разрешать
CORS. После изменения env перезапустите Vite. Для собранного SPA значение
встраивается при сборке: измените env и повторите `npm run build`.
`API_PROXY_TARGET` используется только сервером разработки. Сборка в `dist/`
сама не содержит API-прокси; при размещении нужен reverse proxy для `/api`
или настроенный абсолютный API URL.

Проверки frontend:

```bash
cd frontend
npm test
npm run build
```

В Docker: `docker compose exec -T frontend npm test` и
`docker compose exec -T frontend npm run build`.
