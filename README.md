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

Корневой `.env` уже хранится в репозитории и содержит общие настройки без
секретных значений. Сохраните его. Локальные значения задайте в `.env.local`,
который игнорируется Git. Следующие команды создают файлы только при их отсутствии:

```bash
[ -e .env.local ] || (umask 077; touch .env.local)
[ -e app/.env ] || (umask 077; cp app/.env.example app/.env)
```

Перед первым запуском заполните корневой `.env.local`:

- `POSTGRES_PASSWORD`, `REDIS_PASSWORD`, `RABBITMQ_USER`, `RABBITMQ_PASSWORD`,
  `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD` — локальные учётные данные сервисов.
- `JWT_SECRET` — случайный секрет JWT. Не используйте тестовые ключи.
- Остальные параметры берутся из корневого `.env`: `POSTGRES_DB`, `POSTGRES_USER`,
  `MINIO_BUCKET`, `PRODUCTS_CACHE_TTL` и опубликованные порты. Меняйте их локально
  только при необходимости; `FRONTEND_PORT` и `VITE_API_BASE_URL` имеют значения
  по умолчанию 5173 и `/api`.

Development PHP читает `app/.env` через bind mount. Его `APP_KEY` нужно сгенерировать
после установки Composer-зависимостей. JWT и подключения к PostgreSQL, Redis и
RabbitMQ передаются из Compose; дублировать их в `app/.env` не требуется.
Для S3/отчётов задайте в `app/.env` `AWS_ACCESS_KEY_ID` и `AWS_SECRET_ACCESS_KEY`
равными локальным MinIO credentials, а `AWS_BUCKET` — `MINIO_BUCKET`;
`AWS_ENDPOINT=http://minio:9000` и path-style уже заданы в шаблоне.
Не добавляйте эти локальные файлы и секреты в Git.

Для первого запуска сначала запустите только PHP и его зависимости
(PostgreSQL, Redis, RabbitMQ и MinIO), затем установите Composer-зависимости:

```bash
docker compose --env-file .env --env-file .env.local up -d --build --wait php
make composer-install
```

На этом шаге Nginx и frontend не запускаются. Healthcheck PHP проверяет PHP-FPM
и не требует `APP_KEY` или установленной схемы БД.

**Только если `APP_KEY` в `app/.env` пуст**, сгенерируйте ключ следующей командой.
Если ключ уже задан, пропустите её: `key:generate` может заменить существующий ключ.

```bash
docker compose --env-file .env --env-file .env.local exec -T php php artisan key:generate
```

Для нового окружения создайте схему БД, затем запустите проект целиком:

```bash
docker compose --env-file .env --env-file .env.local exec -T php php artisan migrate
make up
```

Теперь `APP_KEY` задан до запуска Nginx и frontend, который ожидает healthy Nginx.
Товары добавляются через существующий admin API. Для последующих запусков уже
подготовленного окружения достаточно `make up`.

Production-команды `make up-prod`, `make down-prod` и `make logs-prod` используют
`docker-compose.yml` вместе с `docker-compose.prod.yml`. Обычная остановка сохраняет
тома. Для production дополнительно задайте в корневом `.env.local` `APP_KEY`,
`DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD`.
Для контейнерного PostgreSQL используйте `DB_HOST=postgres`, `DB_PORT=5432` и
согласуйте имя БД, пользователя и пароль с `POSTGRES_DB`, `POSTGRES_USER`,
`POSTGRES_PASSWORD`. `APP_KEY` имеет формат Laravel `base64:...`; храните его вне Git.
Frontend profile предназначен для development и production-командами не включается.

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
