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
При принудительном завершении локального процесса используйте имя проекта
для очистки только его Docker-ресурсов; CI дополнительно выполняет описанную ниже
очистку в shell trap и `after_script`. При недоступности daemon или жёстком
завершении runner автоматическая очистка не гарантируется.

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


## GitLab CI — этап 12.3, часть 1

Назначение jobs в текущей конфигурации:

| Job | Stage | Назначение |
|---|---|---|
| `build` | `build` | Сборка PHP `ci`/`prod`, публикация только CI-образа |
| `phpstan` | `code-quality` | Composer validation и статический анализ PHP |
| `php-cs-fixer` | `code-quality` | Проверка форматирования без изменений |
| `rector` | `code-quality` | Проверка преобразований PHP без изменений |
| `tests` | `code-quality` | Подготовка сервисов, все PHPUnit suites и JUnit |
| `frontend` | `code-quality` | Установка по lock-файлу, Vitest и Vite build |
| `production-config` | `code-quality` | Compose, frontend Docker build и Nginx config |
| `production-integration` | `production-integration` | Изолированные HTTP-тесты и архив проверенных образов |
| `publish-production` | `publish` | Проверка архива/IDs и публикация PHP/Nginx |

`build` собирает PHP targets `ci` и `prod`. На этой стадии только CI-образ публикуется в
`$CI_REGISTRY_IMAGE/ci:$CI_PIPELINE_ID`; все четыре проверочных job получают
его из Registry с `pull_policy: always` после успешного этапа `build`.
Production-образ получает локальный тег `php-build-check:$CI_PIPELINE_ID`
в пространстве проекта и не публикуется. Повторный запуск `build` в том же
pipeline обновляет его CI-тег; разные pipeline используют разные теги.
Существующие команды PHP-проверок сохранены.

`build` явно использует публичный `docker:latest`, а не создаваемый CI-образ.
Начальный порядок stages (`build` → `code-quality`) не позволяет запустить
проверочные job до успешного завершения публикации. Все job наследуют
одинаковые job rules. Для передачи CI-образа четырём PHP-job через Registry
`needs` и `dependencies` не требуются; зависимость artifacts для production
публикации описана в части 4.

Загрузку `image` выполняет Runner до `before_script`. Для встроенного Registry
того же проекта он использует credentials, предоставленные GitLab, с
`CI_JOB_TOKEN`; login в `build.before_script` нужен только для публикации и
не передаёт авторизацию другим job. Проверьте право пользователя, запустившего
pipeline, читать Registry и отсутствие конфликтующих credentials для этого
Registry в `DOCKER_AUTH_CONFIG` или Docker config самого runner. Добавлять
login в `before_script` проверочных job для загрузки `image` бессмысленно.

Pipeline запускается для merge request (включая draft), push в основную
ветку (`CI_DEFAULT_BRANCH`) и push в остальные ветки без открытого MR.
Push в feature-ветку с открытым MR не создаёт второй branch pipeline.
Tags, schedules, API/trigger и ручной запуск через Run pipeline пока не
включены. Название основной ветки не захардкожено.

Перед запуском проверьте в GitLab:

- **Settings → General → Visibility, project features, permissions**:
  Container Registry включён; ограничения Registry разрешают запись CI-образа
  из branch и MR pipeline.
- **Settings → CI/CD → Runners** и конфигурацию администратора runner:
  Docker executor, доступ build job к `/var/run/docker.sock`, разрешённый
  `pull_policy: always`, доступ job и runner к Registry и Docker Hub.
  Неназначенные job должны попадать на подходящий runner: проверьте tags,
  Run untagged jobs и Protected. Для feature/MR одного protected runner
  может быть недостаточно. DinD эта конфигурация не использует.
- Runner с host Docker socket должен находиться на выделенном доверенном
  CI-хосте, отдельно от development/production и их данных. Socket даёт
  широкие права на хост; запуск недоверенного кода, включая fork MR,
  на таком runner недопустим. Ограничьте доступ к проекту/runner.
- Встроенные `CI_REGISTRY`, `CI_REGISTRY_IMAGE`, `CI_REGISTRY_USER`,
  `CI_REGISTRY_PASSWORD`, `CI_JOB_TOKEN`, `CI_PIPELINE_ID` доступны и не переопределены
  пользовательскими переменными. Постоянный Registry token не требуется.
  Вход выполняется через `--password-stdin`; временный Docker config
  удаляется при обычном завершении job. Не включайте debug trace для
  проверки credentials.
- **Build → Pipeline editor → Validate**: проверьте YAML и сценарии branch,
  MR и основной ветки. Затем подтвердите реальным pipeline, что проверочные
  job скачивают именно его CI-образ, в том числе на другом runner.

Настройки runner и Registry не хранятся в этом репозитории и должны быть
подтверждены администратором. Если безопасный socket runner недоступен,
сначала выберите подходящий способ сборки (например, rootless BuildKit
с совместимым runner); DinD или передачу образов через artifacts нельзя
подставлять без проверки условий. VPS, HTTPS и deployment здесь не настраиваются.


## GitLab CI — этап 12.3, часть 2

PHPStan job сначала выполняет `composer validate --strict` из `/var/www/app`
для активного `app/composer.json` и его lock-файла. Обновление зависимостей
не выполняется.

Test job генерирует временные APP_KEY и JWT_SECRET без вывода значений и
экспортирует их для Artisan, PHPUnit и дочерних процессов. При отсутствии
`.env` создаётся пустой файл только внутри CI-контейнера: это устраняет
предупреждения Dotenv в PHPUnit. Секреты в файл не записываются.
Не включайте debug trace: отчёты и диагностические сообщения сторонних
инструментов тоже могут содержать чувствительные данные.

`docker/ci/wait-services.php` запускается из checkout после загрузки CI-образа.
Он проверяет подключение к PostgreSQL с тестовыми credentials, AMQP-авторизацию
RabbitMQ и доступ к S3-бакету MinIO. Отсутствующий бакет создаётся и повторно
проверяется до запуска тестов; отдельного фонового `minio-mc` больше нет.
Ошибка подготовки завершает job ненулевым кодом. Ожидание каждого сервиса
ограничено `CI_SERVICE_WAIT_TIMEOUT` (по умолчанию 120 секунд, допустимо 1–600),
плюс время завершения текущей операции с сетевыми таймаутами 5 секунд.
Сообщения исключений не печатаются, чтобы не раскрыть credentials.

`app/phpunit.xml` включает Feature, Integration и Unit. PHPUnit JUnit XML
пишется в `$CI_PROJECT_DIR/reports/phpunit.xml`; GitLab сохраняет его как
JUnit report и обычный artifact с `when: always`, включая падение тестов.
Если подготовка окружения не дошла до PHPUnit, XML не создаётся.
Локальная генерация XML не подтверждает его загрузку сервером GitLab.


## GitLab CI — этап 12.3, часть 3

Job `frontend` использует Node 24, выполняет `npm ci --no-audit --no-fund`
по `frontend/package-lock.json`, существующие Vitest-тесты (`npm test`) и
production-сборку Vite (`npm run build`). `VITE_API_BASE_URL=/api` соответствует
production Dockerfile. Новых зависимостей и тестовых фреймворков нет.

Job `production-config` проверяет базовый, frontend и production Compose
через `config --quiet`, используя только корневой `.env` и явно заданные
публичные тестовые значения. `.env.local` и production-секреты не нужны.
Затем собирается frontend Docker target `prod` с локальным тегом
`$CI_REGISTRY_IMAGE/frontend-config-check:$CI_PIPELINE_ID` и выполняется
`nginx -t` внутри полученного образа. Образ не публикуется; контейнер проверки
не имеет сети, опубликованных портов или подключённых томов и удаляется
после завершения. Проверка не запускает сервисы Compose и не меняет их данные.
Docker-сборка дополнительно подтверждает упаковку Vite-результата и Nginx
конфигурации, поэтому не заменяется одной сборкой Vite на Node.

Оба job наследуют общие job rules и выполняются на стадии `code-quality`
после успешного `build`. Они явно используют собственные публичные образы,
а четыре PHP-job продолжают получать опубликованный CI-образ. Для
`production-config` нужен тот же безопасный доступ к Docker socket, что и
для `build`, и Compose с поддержкой `!reset`. HTTP-интеграция и публикация production-образов выполняются отдельными
стадиями части 4, описанными ниже.


## GitLab CI — этап 12.3, часть 4

Порядок стадий: `build` → `code-quality` → `production-integration` → `publish`.
Все job сохраняют общие workflow/job rules. Публикация разрешена только после
успеха всех предыдущих стадий; `needs` не используется. Job `publish-production`
скачивает artifacts только из `production-integration` через `dependencies`,
что не отменяет порядок stages.

Integration job использует существующий Node HTTP-сценарий в небольшом
служебном образе Node 24 + Docker CLI/Compose. Checkout передаётся через
`git archive HEAD` и stdin, без bind mount каталогов runner. Файлы canary
передаются в тестовый Nginx через `docker cp`. Проверяющий контейнер дополнительно подключается
к случайно названной сети проверочного Compose-проекта; запросы идут
на `http://nginx` внутри этой сети. Порты тестового приложения не публикуются.
Новые БД, credentials и volumes не связаны с development/production.
Запускаются только тестовые PHP/Nginx и их инфраструктурные зависимости,
без production workers/scheduler.

Проверяются SPA/assets/cache, API query/body/headers/Authorization и JSON-ошибки,
затем недоступность PHP и восстановление после его пересоздания без перезапуска
Nginx. После успешных проверок `docker save` сохраняет именно проверенные
PHP/Nginx-образы в `reports/production-images.tar.gz`, вместе с их IDs и checksum.
Архив сжат gzip. Лимит размера artifacts в GitLab должен вмещать этот архив;
проверьте доступную квоту перед запуском. Локально получен архив около 272 MiB;
лимит должен превышать фактический размер с запасом. Для artifacts задан
`expire_in: 1 day`; фактическое удаление зависит также от настроек GitLab.
Если архив уже удалён, повторная публикация требует повторного выполнения
интеграционного job. Изображения контейнеров с runtime-конфигурацией
не экспортируются. Секреты и тестовые данные не включаются в архив образов.

Publish job проверяет checksum, загружает архив без пересборки, сравнивает IDs
и публикует `$CI_REGISTRY_IMAGE/php:$CI_PIPELINE_ID` и
`$CI_REGISTRY_IMAGE/nginx:$CI_PIPELINE_ID`. Теги связывают образы с pipeline;
`latest` не публикуется. Публикация выполняется для всех разрешённых workflow
pipeline, включая MR, при достаточных правах Registry. Два push не атомарны:
при ошибке второго job падает и может быть повторён с теми же artifacts.

Node `finally` удаляет свой стенд. Shell trap и `after_script` дополнительно
очищают только контейнеры/сети/volumes случайного проекта из state-файла,
имеющие дополнительные labels этого проекта и текущего CI-job;
служебный контейнер проверяется по ID и label текущего CI-job. State-файлы
не содержат credentials. При обычных ошибках и поддерживаемой отмене job
очистка выполняется; после SIGKILL всего runner или потери Docker daemon
может потребоваться ручная очистка по сохранённому имени проекта.
Собранные образы остаются в Docker. Подготовка не запускает реальный production.

Требуются выделенный доверенный socket runner, Git, Node/Docker базовые образы
и Compose с поддержкой `!reset` и `!override`. VPS и deployment не настраиваются.

На момент завершения локальной реализации реальный GitLab pipeline,
Registry login/push и загрузка/скачивание artifacts через GitLab не проверены.
Локальные проверки YAML, shell, Docker, PHPUnit, frontend и HTTP подтверждают
только локальный результат, а не работоспособность серверного CI/CD.
Для подтверждения этапа в GitLab необходимо проверить настройки выше,
успешное получение CI-образа, передачу архива между job и наличие обоих
production-тегов своего pipeline в Registry.

`reports/` содержит генерируемые XML, архивы, checksum/IDs и state-файлы;
каталог исключён из Git и backend Docker-контекста. Frontend Docker-контекст
ограничен `frontend/`, где зависимости, dist и coverage исключены отдельно.
Временные test.env/override создаются через `mkdtemp` в системном временном
каталоге и удаляются сценарием; в репозиторий их копировать не следует.
