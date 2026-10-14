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

## Production (этап 12.2)

Нужен Docker Compose 2.24.4+ (overlay использует `!reset`).
`make up-prod`, `make down-prod` и `make logs-prod` используют базовый файл вместе
с `docker-compose.prod.yml`. Остановка сохраняет volumes; не добавляйте `-v`.
Development и production на одном хосте следует запускать с разными
`COMPOSE_PROJECT_NAME` и `NGINX_PORT`, чтобы не заменять контейнеры друг друга.
Образы также получают отдельные имена от Compose для каждого проекта.
Переопределения при вызове Makefile передавайте аргументами, например
`make up-prod COMPOSE_PROJECT_NAME=pizza-production NGINX_PORT=8081`;
при последующих `down-prod` и `logs-prod` используйте то же имя проекта.
Не включайте development-профиль `frontend` через `COMPOSE_PROFILES` в production.

В корневом `.env.local` задайте перечисленные выше секреты сервисов и `JWT_SECRET`,
а также `APP_KEY`, `APP_URL`, `DB_CONNECTION`, `DB_HOST`, `DB_PORT`, `DB_DATABASE`,
`DB_USERNAME`, `DB_PASSWORD`. Для контейнерного PostgreSQL используйте
`DB_CONNECTION=pgsql`, `DB_HOST=postgres`, `DB_PORT=5432`; согласуйте остальные
DB-параметры с `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD`.
`APP_KEY` — постоянный ключ Laravel формата `base64:...`; храните его вне Git.
Compose отклоняет пустые `APP_KEY` и `JWT_SECRET` до создания контейнеров.
`APP_URL` — внешний адрес сайта, включая схему и нестандартный порт.
Production не читает `app/.env`: настройки передаются через Compose.

При первом запуске сначала соберите образы и запустите PHP с зависимостями:

```bash
docker compose --env-file .env --env-file .env.local -f docker-compose.yml -f docker-compose.prod.yml config --quiet
docker compose --env-file .env --env-file .env.local -f docker-compose.yml -f docker-compose.prod.yml build
docker compose --env-file .env --env-file .env.local -f docker-compose.yml -f docker-compose.prod.yml up -d --wait php
docker compose --env-file .env --env-file .env.local -f docker-compose.yml -f docker-compose.prod.yml run --rm minio-init
```

Только для новой БД либо согласованного обновления схемы после оценки миграций
и резервного копирования выполните:

```bash
docker compose --env-file .env --env-file .env.local -f docker-compose.yml -f docker-compose.prod.yml exec -T php php artisan migrate --force
```

Затем `make up-prod`. Для последующих запусков подготовленного окружения
достаточно `make up-prod`; миграции автоматически не выполняются.

Production Nginx содержит собранный Vue SPA; Node.js, Vite dev server и bind
mount исходников не нужны. `/` теперь отдаёт frontend, вложенные SPA-пути
возвращают `index.html`. `/api` и `/api/*` передаются в Laravel PHP-FPM
с исходными URI, методами, телом, query и заголовками; `/up` остаётся Laravel
health endpoint. Отсутствующие API-ресурсы не подменяются HTML SPA.
HTML проверяется браузером при каждом запросе (`no-cache`), Vite assets с хешем
кэшируются на год (`immutable`). Статика без хеша требует повторной проверки
(`no-cache`). Отсутствующие JS, CSS, изображения и другие известные статические
форматы возвращают 404, в том числе вне `/assets/`; SPA fallback предназначен
для путей страниц. Dotfiles, PHP-файлы и source maps не раздаются, включая `/assets/`.
Заголовки кэширования API сохраняются от Laravel; Nginx не кэширует FastCGI-ответы.

API в Docker production-сборке всегда `/api` на том же origin. Переменные
`VITE_API_BASE_URL` и `API_PROXY_TARGET` из `.env.local` не меняют этот образ.
Сборка использует `npm ci` и lock-файл; локальные env-файлы не входят в context,
Composer `app/auth.json` и локальные кэши инструментов в `app/var` также исключены
из backend context. В frontend runtime
попадают только статика и конфигурация Nginx. Секреты доступны только
backend-контейнерам. Наружу публикуется только порт Nginx; PostgreSQL, Redis,
RabbitMQ и MinIO доступны внутри Docker-сети. Прямой Compose endpoint обслуживает
HTTP; TLS и доверие к внешнему reverse proxy настраиваются отдельно при развёртывании.
Frontend использует Node 24 для сборки и Nginx 1.30.5 в runtime. Lock-файл фиксирует
JS-зависимости; базовые Docker-теги не гарантируют побитово одинаковый образ.
Обновления базовых образов требуют повторной сборки и HTTP-проверок.

Проверка (замените 8080 своим `NGINX_PORT`):

```bash
curl -i http://localhost:8080/
curl -i http://localhost:8080/catalog/page/2
curl -i http://localhost:8080/up
curl -i -H 'Accept: application/json' 'http://localhost:8080/api/products?page=1'
curl -i -H 'Accept: application/json' http://localhost:8080/api/products/2147483647
```

Ожидаются HTML 200 для SPA, 200 для `/up` и каталога, JSON 404 для отсутствующего
товара (выберите заведомо отсутствующий ID). Для уже подготовленного изолированного
стенда HTTP-проверка использует только чтение и заведомо невалидный login:

```bash
cd frontend
PRODUCTION_URL=http://localhost:8080 npm run test:production
```

Она предполагает отсутствие товара с ID `2147483647`. Проверка передачи
`Authorization` выполняется только при переданных `PRODUCTION_TEST_TOKEN` и
`PRODUCTION_TEST_USER_EMAIL`; без токена этот тест явно пропускается.
Секретный токен не передавайте аргументом командной строки и не сохраняйте в Git.

Воспроизводимая проверка HTTP-интеграции этапа 12.2 (Node.js 24+, локальный Docker
и Compose) не требует
локальных credentials или ручной подготовки БД:

```bash
cd frontend
npm run test:production:isolated
```

Скрипт создаёт случайное имя Compose-проекта, собственные credentials, новые тома
и случайный порт на `127.0.0.1`; `.env.local` и `app/.env` не используются.
Он собирает PHP/Nginx, выполняет `nginx -t`, миграции только новой тестовой БД,
создаёт 31 товар и тестового пользователя, проверяет данные второй страницы,
MIME-типы, кэширование, JSON-ошибки, тело, query и заголовки, включая `Authorization`.
Несекретные canary-файлы позволяют проверить запреты на реально существующих
dotfiles/source maps и кэширование статики без хеша. Затем он останавливает только
свой PHP, проверяет 502/504 API при доступном SPA и пересоздаёт PHP для проверки
восстановления без перезапуска Nginx. Логи PHP/Nginx проверяются на ошибки приложения
и наличие сгенерированных секретов без вывода их содержимого.
HTTP-запросы ограничены десятью секундами;
подключение Nginx к PHP — пятью, чтение ответа сохраняет стандартный таймаут Nginx.
При завершении или ошибке удаляются контейнеры и тома только созданного тестового
проекта. Основное окружение не останавливается. Собранные образы остаются в Docker.
Если процесс был принудительно прерван, используйте имя проекта и временные
env/override-файлы из `/tmp` для очистки только этого стенда.

Диагностика:

```bash
make logs-prod
docker compose --env-file .env --env-file .env.local -f docker-compose.yml -f docker-compose.prod.yml ps -a
docker compose --env-file .env --env-file .env.local -f docker-compose.yml -f docker-compose.prod.yml exec -T nginx nginx -t
```

При 502 проверьте состояние и логи `php`, при 500 API — Laravel-ошибки в логах
`php` (production пишет в stderr), APP_KEY, DB credentials и наличие миграций.
Healthcheck Nginx проверяет SPA и Laravel `/up`, но не готовность схемы БД.
При ошибках загрузки JS/CSS пересоберите `nginx`, проверьте URL `/assets/` из
HTML и кэш внешнего proxy. При сбоях отчётов смотрите `report-worker`,
`outbox-worker`, `report-scheduler`, `rabbitmq` и `minio` в `make logs-prod`.

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
сама не содержит API-прокси; Docker production обслуживает её через Nginx,
настроенный выше. При другом способе размещения нужен API-прокси или абсолютный URL.

Проверки frontend:

```bash
cd frontend
npm test
npm run build
```

В Docker: `docker compose exec -T frontend npm test` и
`docker compose exec -T frontend npm run build`.
