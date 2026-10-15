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

## Release manifest и запуск готовых образов

`docker-compose.release.yml` применяется **третьим**, после `docker-compose.yml`
и `docker-compose.prod.yml`. Это отдельный режим: существующий `make up-prod`
по-прежнему собирает исходники и для запуска release-образов не подходит.
Release overlay удаляет development-сервис `frontend` даже при включённых profiles,
убирает `build` у всех пяти прикладных сервисов и задаёт обязательные `PHP_IMAGE`
и `NGINX_IMAGE`. PHP, report-worker, outbox-worker и report-scheduler получают
одну ссылку `PHP_IMAGE`; Nginx получает `NGINX_IMAGE`.
Volumes, сети, команды, environment, healthchecks и зависимости остальных
сервисов наследуются без изменений. Инфраструктурные образы пока сохраняют
существующие теги; manifest фиксирует только два прикладных образа.

Формат JSON manifest v1:

| Поле | Значение |
|---|---|
| `schema_version` | Число `1` |
| `git_sha` | Полный Git SHA исходников проверенных образов, 40 lowercase hex |
| `pipeline_id` | Положительный GitLab pipeline ID как строка |
| `deployment_config.version` | Число `1`, версия контракта release Compose |
| `deployment_config.git_sha` | Тот же SHA; Compose-файлы нужно брать из этого коммита |
| `images.php` | Полная ссылка `<CI_REGISTRY_IMAGE>/php@sha256:<64 hex>` |
| `images.nginx` | Полная ссылка `<CI_REGISTRY_IMAGE>/nginx@sha256:<64 hex>` |

Обе ссылки должны принадлежать одному Registry project. Теги, локальные image IDs,
credentials в URL и неизвестные поля отклоняются. Секреты, домен, runtime environment
и Docker credentials в manifest не входят. Это описание формата, а не manifest
существующего production-релиза.

Существующий CI публикует `php:$CI_PIPELINE_ID` и `nginx:$CI_PIPELINE_ID` после
проверки экспортированных образов. После **успешной публикации обоих образов**
следует получить их Registry manifest digests и передать полные ссылки как
`PHP_IMAGE`/`NGINX_IMAGE`. Локальный `.Id` из `production-images.ids` — не Registry
digest. Нельзя подменять ссылки на digest тегами, даже тегом pipeline.
Генерация manifest пока не подключена к CI; publish/workflow rules не изменены.

Утилита требует Node.js 24+ там, где создаётся/проверяется manifest.
Задайте `RELEASE_MANIFEST` и `RELEASE_ENV` как пути к выбранным файлам.
Сценарии ниже выполняются в отдельном shell-блоке с `set -eu`: ошибка любой
обязательной команды завершает блок ненулевым кодом. Не продолжайте работу
с Compose после ошибки и не объединяйте сценарии как попытку fallback.

Создание нового manifest:

```bash
(
  set -eu
  : "${RELEASE_MANIFEST:?Set a new manifest path}" "${RELEASE_ENV:?Set a new env path}"
  # CI_COMMIT_SHA, CI_PIPELINE_ID, PHP_IMAGE, NGINX_IMAGE заданы вызывающей стороной.
  node docker/release/manifest.mjs create "$RELEASE_MANIFEST"
  node docker/release/manifest.mjs validate "$RELEASE_MANIFEST"
  node docker/release/manifest.mjs export-env "$RELEASE_MANIFEST" "$RELEASE_ENV"
)
```

Проверка и экспорт уже существующего manifest (только осознанно выбранного):

```bash
(
  set -eu
  : "${RELEASE_MANIFEST:?Set the existing manifest path}" "${RELEASE_ENV:?Set a new env path}"
  node docker/release/manifest.mjs validate "$RELEASE_MANIFEST"
  node docker/release/manifest.mjs export-env "$RELEASE_MANIFEST" "$RELEASE_ENV"
)
```

`export-env` повторно читает и валидирует manifest, записывает полный env-файл
с правами `0600` во временный каталог рядом с итоговым файлом, закрывает и
синхронизирует запись, затем публикует файл атомарным hard link без перезаписи.
Существующий файл, каталог или symlink на месте `RELEASE_ENV` приводит к ошибке.
Временный каталог удаляется при обычном успехе и исключениях. Нужна поддержка
hard links файловой системой каталога назначения (обычная Linux filesystem);
если публикация невозможна, команда завершается ненулевым кодом, без fallback.
Не используйте shell-перенаправление команды `env` для создания release.env.
После SIGKILL или потери питания может остаться временный каталог; итоговый
файл при этом либо отсутствует, либо содержит полностью подготовленные данные.

Manifest создаётся эксклюзивно, без времени генерации и произвольных env-полей.
Повторное создание по существующему пути завершается ошибкой. Это защита утилиты
от перезаписи, не подпись и не серверная защита релиза от изменения. Валидатор
проверяет структуру, но не обращается к Registry и не доказывает происхождение
образов. Связь digest с проверенными образами и SHA должен обеспечить publish job
при последующем подключении генерации. Сохраняйте manifest вместе с тремя
Compose-файлами из `deployment_config.git_sha`; формат версии 1 предполагает
одинаковую архитектуру сервера и опубликованных образов.

Для одного только Compose Node.js не нужен: используется подготовленный
несекретный `release.env`. Команды состояния ниже требуют Node.js 24+ на сервере.
Не добавляйте в release.env runtime credentials. Для проверки
конфигурации без вывода значений секретов:

```bash
# Shell environment имеет приоритет над --env-file; исключаем подмену версии.
unset PHP_IMAGE NGINX_IMAGE
COMPOSE_PROFILES= docker compose --env-file .env --env-file .env.local \
  --env-file /path/to/release.env \
  -f docker-compose.yml -f docker-compose.prod.yml -f docker-compose.release.yml \
  config --quiet
```

Во всех последующих операциях используйте те же env-файлы, три Compose-файла
и постоянный `COMPOSE_PROJECT_NAME`. Compose сам не проверяет синтаксис digest:
не используйте произвольный release.env вместо вывода валидатора. Получение образов
выполняется через `pull`, запуск — через `up --no-build`; команды `build` и
`make up-prod` в этом режиме не используются. Исходники `app/` и `frontend/`
на сервере не нужны. Runtime credentials остаются в отдельно подготовленном
закрытом `.env.local`, не в manifest и не в artifacts.

Порядок первоначальной инициализации из раздела Production сохраняется: получение
образов вместо сборки, PHP с зависимостями, MinIO init, согласованные миграции,
затем остальные сервисы. Миграции выполняются в `php`, следовательно используют
тот же закреплённый образ; автоматически они не запускаются. Этот overlay
не реализует SSH-deploy, rollback, TLS или deploy-job. Отдельные backup-команды описаны ниже.

Проверки без запуска контейнеров, миграций, Registry и локальных env-файлов:

```bash
node --test docker/release/release.test.mjs
```

Тесты проверяют manifest/CLI, запрет перезаписи и раскрытия входных данных при
ошибках, отсутствие build/frontend в объединённом Compose (даже с profiles `*`),
одинаковый PHP digest и сохранение остальных production-настроек. Используются
только публичные fixtures и временные каталоги; Docker daemon не требуется.

## Состояние релизов и проверка перед deploy

`docker/release/release.sh` поддерживает read-only `status` и `check`, а также
описанные ниже `accept-backup` и `mark-migrating` для фиксации состояния backup.
Команды `status` и `check` не создают/изменяют состояние, не скачивают образы, не запускают
и не останавливает сервисы, не выполняет миграции или переключение версии.
Нужны Linux, Node.js 24+, util-linux `flock`, а для `check` — Docker CLI/Compose.
Docker daemon, SSH и Registry для проверки конфигурации не требуются.

Каталог состояния должен быть заранее подготовлен и закрыт от посторонней записи
(рекомендуются `0700` для каталога и `0600` для state.json). Его нельзя удалять,
заменять или копировать в другое место во время операций: блокировка привязана
к inode каталога. Все будущие операции записи должны использовать этот же каталог
и протокол блокировки. Несогласованный каталог состояния означает отказ, не
автоматическую инициализацию или восстановление из временных файлов.

Формат `state.json` v1:

| Поле | Содержание |
|---|---|
| `schema_version` | `1` |
| `project` | Постоянное имя Compose project; при существующей установке — её фактическое имя |
| `revision` | Неотрицательное целое, увеличивается при переходе |
| `current`, `previous` | Полные проверенные manifest успешных релизов либо `null` |
| `operation` | `{ "manifest": ..., "phase": ... }` либо `null` |

Начальное состояние формируется библиотекой `initialState(project)`:
revision 0, current/previous/operation равны null. Его явная регистрация через
`persist(directory, null, state)` допустима только для новой установки, под
блокировкой; готовой команды инициализации пока нет. Существующую установку
нельзя регистрировать как пустую: сначала нужно установить её реальный project
и релиз. Отсутствующий, повреждённый или неподдерживаемый state.json даёт ошибку.

Идентичность релиза — SHA-256 нормализованных значений всех полей manifest,
включая оба image digest. Тот же pipeline ID с изменённым manifest конфликтует
с сохранённым релизом. Незавершённая операция допускает только свой manifest.
Другой релиз не может молча продолжить её; автоматического recovery нет.

Библиотека допускает последовательные фазы:

```text
prepared → images_ready → quiescing → quiesced → backup_ready
         → migrating → migrated → starting → verified → committed
```

Это модель будущего deploy, а не реализация этих действий. `begin` того же
текущего релиза или той же операции не меняет состояние. Пропуск фаз, смена
manifest в операции и неявный возврат previous запрещены. Commit обновляет
current/previous и завершает operation одной записью. Фазы не доказывают,
что соответствующие действия действительно выполнены: будущий orchestrator
обязан проверять реальные сервисы и БД перед переходом. Полного журнала событий
и процедуры восстановления данных в этом шаге нет.

Запись библиотеки `persist` требует открытого read-only FD 9 на каталог состояния
и эксклюзивной `flock` на нём. Она проверяет ожидаемое старое состояние, допустимый
следующий переход и неизменность project. Новый JSON записывается и синхронизируется
в закрытом временном каталоге рядом с state.json. Первая регистрация использует
hard link без перезаписи; обновление — атомарный rename, затем fsync каталога.
При обычной ошибке до публикации старые current/previous остаются целыми.
После SIGKILL возможен временный каталог; он не считается состоянием и не
восстанавливается автоматически. Ошибка fsync после rename означает неопределённый
результат подтверждения записи: сначала нужно перечитать состояние, а не повторять
переход вслепую. Требуется filesystem с соответствующими Linux-семантиками.

Команды (аргументы-пути должны указывать на заранее подготовленные файлы):

```bash
sh docker/release/release.sh status /path/to/state-directory
sh docker/release/release.sh check /path/to/state-directory \
  /path/to/release.json /path/to/compose-bundle /path/to/runtime.env
```

Обе команды берут неблокирующую эксклюзивную flock; конкурирующая операция
завершается ненулевым кодом без ожидания и без записи файлов. `status` выводит
только project, revision, идентификаторы current/previous и текущую фазу.
`check` проверяет manifest и совместимость с состоянием, затем выполняет только
`docker compose config --format json`, удерживая вывод в памяти. Bundle содержит
корневой публичный `.env` и три Compose-файла из коммита manifest; runtime.env
передаётся отдельно и содержит закрытые настройки. Compose project берётся
из состояния через явный `--project-name`, а ссылки на образы — из manifest,
с приоритетом над shell/env-файлами. Проверяются отсутствие build, frontend
и bind mounts, точные прикладные образы и production environment PHP.
Содержимое конфигурации и ошибки Docker не выводятся: они могут содержать секреты.

Дочерний Compose получает только явный список переменных окружения:
`PATH`, `HOME`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR` для поиска CLI/config;
`DOCKER_CONFIG`, `DOCKER_CONTEXT`, `DOCKER_HOST`, `DOCKER_API_VERSION`, `DOCKER_TLS`,
`DOCKER_TLS_VERIFY`, `DOCKER_CERT_PATH`, `SSH_AUTH_SOCK` для конфигурации подключения;
`HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` и их lowercase-варианты, `SSL_CERT_FILE`,
`SSL_CERT_DIR` для proxy/CA. Значения не печатаются. Другие shell-переменные,
включая `DB_*`, `APP_*`, переменные портов и произвольные `COMPOSE_*`, не наследуются.
`COMPOSE_PROFILES` принудительно пуст, `PHP_IMAGE`/`NGINX_IMAGE` берутся из manifest.
Приоритет runtime.env над публичным bundle/.env сохраняется. Настройки приложения
нужно задавать в этих файлах; ссылки на посторонние shell-переменные внутри них
не поддерживаются. Окружение самого Node/shell и доверенный PATH эта фильтрация
не изолирует; она относится только к дочернему процессу Compose.

`check` не проверяет доступность образов, их происхождение, здоровье сервера,
backup, совместимость миграций или побайтовое соответствие bundle Git SHA.
Успешная проверка не означает разрешение или выполнение deploy. Установленные
в production volumes и сети эти команды не меняют.

Безопасные тесты (fixtures, fake Docker и Compose config; без daemon/Registry):

```bash
node --test docker/release/release.test.mjs docker/release/deploy.test.mjs
```

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

### Корректное завершение queue worker

Production-стадия PHP Dockerfile устанавливает `pcntl` и проверяет расширение
при сборке. Worker entrypoint проверяет его до настройки RabbitMQ, затем через
`exec` запускает Laravel worker без shell между ним и Docker. PHP-FPM entrypoint
и StopSignal не меняются: у проверенного локального исходного образа это SIGQUIT.
Laravel Worker обрабатывает SIGQUIT и SIGTERM, завершает текущую задачу и выходит.
Наличие `pcntl` также включает штатный timeout Laravel worker (по умолчанию 60 с).

Без Docker и подключения к очередям можно проверить настоящий Laravel Worker
с очередью в памяти и контролируемой задачей (нужны PHP с pcntl и app/vendor):

```sh
node --test docker/release/queue-worker.test.mjs
```

Тест посылает сигнал во время задачи, разрешает ей завершиться только после
регистрации сигнала и проверяет подтверждение задачи, exit code 0 и отсутствие
запуска второй задачи. Бюджет завершения — 10 секунд, текущий Compose default;
это тестовый предел, а не подтверждение достаточности для реальных отчётов.
Увеличение production grace period требует отдельной оценки длительности задач.

Отдельный opt-in тест требует локального Docker daemon на
`unix:///var/run/docker.sock` и **уже пересобранного production-образа**.
Передайте его локальный неизменяемый image ID через переменную
`QUEUE_WORKER_TEST_IMAGE`; теги не принимаются. Например, после отдельной сборки:

```sh
docker build --pull=false --target prod -f docker/php/Dockerfile -t pizza-queue-signal-check:local .
QUEUE_WORKER_TEST_IMAGE="$(docker image inspect pizza-queue-signal-check:local --format '{{.Id}}')" \
  node --test docker/release/queue-worker-image.test.mjs
```

Сборка может требовать доступных зависимостей; эти команды не являются deploy.
Без переменной три image-теста пропускаются. Они проверяют SIGQUIT, SIGTERM и
обычный Docker stop с унаследованным SIGQUIT, PHP как PID 1, отсутствие SIGKILL/OOM
и завершение за 10 секунд. Создаётся только изолированный контейнер без сети,
production volumes и env-файлов; образ не скачивается (`--pull=never`). Тест
удаляет только собственный контейнер с проверенной уникальной меткой.
Запускается fixture напрямую, без production entrypoint, Laravel bootstrap,
RabbitMQ и реальных данных. Проверка pcntl также добавлена в существующий
production integration runner; сам runner запускает отдельную БД и миграции,
поэтому для проверки только сигналов используйте команды выше.

Эти тесты не подтверждают доставку/ack RabbitMQ, сохранность файлов отчётов,
достаточность grace period для настоящих задач или поведение при SIGKILL.
Остановка outbox и scheduler описана отдельно ниже; полный deploy не реализован.

### Остановка outbox и scheduler

Production outbox запускается как `php artisan outbox:process --worker`.
После `exec` в production entrypoint PHP является PID 1. SIGQUIT (унаследованный
StopSignal), SIGTERM и SIGINT запрещают следующий claim, но не прерывают текущий
listener и последующий `markPublished`/`markFailed`. Worker забирает по одному
событию: до 100 за цикл, затем пауза 60 секунд, прерываемая сигналом. Разовая
`outbox:process` без флага сохраняет прежний batch size 100. Цена более точной
остановки — отдельная claim-транзакция на событие. Сигнал во время уже начатого
claim не отменяет эту операцию; полученное единственное событие завершается.

Scheduler запускается через `/usr/local/bin/scheduler.php` вместо `schedule:work`.
Supervisor как PID 1 запускает foreground `schedule:run` на следующей минутной
границе, без параллельных запусков и catch-up пропущенных минут. Во время остановки
новых `schedule:run` не будет; текущий invocation и его foreground потомки
получают возможность закончить. Сигнал им намеренно не пересылается: Laravel
может завершить Event при сигнале, освободив mutex до завершения задачи.
Supervisor использует отдельную POSIX session/process group и reaping потомков.
Нужны pcntl и posix; сборка проверяет их наличие. PHP-FPM StopSignal не изменён.

Это решение рассчитано на текущую единственную daily foreground-команду
`reports:generate-daily` в `app/routes/console.php`. Она создаёт отчёт и ставит
job в очередь, а не выполняет всю генерацию внутри scheduler. Новые background,
sub-minute, detached или несколько последовательных scheduled events потребуют
отдельной проверки: уже запущенный `schedule:run` здесь дренируется целиком.
Бизнес-идемпотентность повторного daily-запуска не добавлена. `withoutOverlapping`
защищает от пересечения, но не от повторного выполнения после завершения.

Для этих двух сервисов Docker `stop_grace_period` — 70 секунд, внутренний предел
после первого сигнала — 60 секунд. Повторный сигнал не продлевает ожидание.
Outbox по SIGALRM выходит с кодом 124; scheduler принудительно завершает process
group и выходит с кодом 124. Это аварийная остановка, не успешное завершение
операции. Зависшие не прерываемые системные вызовы могут потребовать Docker SIGKILL;
беспроблемное завершение любых реальных операций за этот срок не гарантировано.

**Полного deploy ещё нет.** Будущая процедура обязана проверить фактические
container exit codes и OOMKilled после остановки и запретить переключение при
124, 137 или другом ненулевом результате. Один exit code `docker compose stop`
не доказывает успешное завершение приложения. Миграции и автоматический
переход к следующей фазе здесь не реализованы; backup вызывается отдельно.

Outbox lease остаётся 5 минут; `processing_token` защищает отметки состояния
после повторного claim, но не отменяет уже выполненный внешний эффект.
После SIGKILL/тайм-аута событие может остаться processing до истечения lease и
будет доступно повторно, если не было published/failed. При прерывании между
listener и `markPublished` возможен повтор. Exactly-once не гарантируется;
существующий WelcomeEmailStub дедуплицирует запись по event/message type, но это
не универсальная гарантия для будущих listener. Длительная обработка дольше lease
также допускает конкурентный повтор. Протокол lease/token и retry не изменён.
Текущее outbox-событие — UserRegistered, а не RabbitMQ report completion.

Изолированные проверки без Laravel bootstrap, env-файлов и внешних сервисов:

```sh
node --test docker/release/background.test.mjs
```

Нужны host PHP с pcntl/posix и `app/vendor`. Fixture использует настоящий
OutboxProcessor/ProcessOutbox с repository в памяти и настоящий Laravel Scheduling
Event с временным mutex и управляемой дочерней задачей. Проверка reaping всей
process group при тайм-ауте запускается только в контейнере как PID 1; на хосте
этот тест пропускается. SIGALRM-тест outbox вызывает настоящий deadline handler
напрямую, не подтверждая фактическое ожидание 60 секунд.

Контейнерный вариант принимает **локальный immutable image ID** через
`BACKGROUND_TEST_IMAGE` и использует только daemon `unix:///var/run/docker.sock`:

```sh
BACKGROUND_TEST_IMAGE="$QUEUE_WORKER_TEST_IMAGE" node --test docker/release/background.test.mjs
```

Переменную задавайте явно ID свежесобранного локального production PHP-образа
с pcntl/posix. Outbox-классы и scheduler используются только из образа:
production-код не подменяется bind mounts. Тест монтирует лишь read-only fixture
и собственный временный каталог для синхронизации; image ID и список mount
destinations проверяются при создании контейнера. Scheduler загружается из
`/usr/local/bin/scheduler.php`, установленного Dockerfile.
Контейнеры без сети, без project volumes, без env-файлов, с read-only
rootfs и `--pull=never`; удаляются только собственные контейнеры с проверенной
меткой `pizza.background-test`. При недоступности daemon/аварийном завершении
самого test runner очистка не гарантирована: проверяйте оставшиеся метки вручную.

Проверки graceful-stop подтверждают завершение текущей операции, отсутствие
следующего claim, освобождение тестового scheduler mutex и отсутствие оставшихся
foreground потомков. Они не подтверждают восстановление реальных PostgreSQL
lease, дедупликацию писем, атомарность PostgreSQL/RabbitMQ, MinIO или поведение
production entrypoint при остановке во время начального `config:cache`.

### Резервные копии релиза

`docker/release/backup.sh` — отдельный инструмент, а не deploy. Команды
`preflight`, `create`, `verify`, `restore-test` используют тот же FD 9 / `flock`
каталога состояния, что и `release.sh`. `release.sh status/check` по-прежнему
не останавливают сервисы и не создают backup. Нужны Linux, Node.js 24+, util-linux
flock, локальный Docker socket `/var/run/docker.sock`, уже имеющиеся образы
PostgreSQL и production PHP с ZipArchive. Docker context/remote host из shell
игнорируются. Образы не скачиваются (`--pull=never`).

Backup root должен заранее существовать, принадлежать пользователю команды и
иметь права 0700. Рекомендуется отдельный диск вне Docker data volumes. Команда
не читает `.env` и не принимает passwords в аргументах или конфигурации.
Пример **шаблона** settings.json (значения в угловых скобках заменяются реальными
локальными ID; это не готовая production-конфигурация):

```json
{
  "schema_version": 1,
  "project": "<existing-compose-project>",
  "postgres_container": "<full-64-hex-container-id>",
  "minio_container": "<full-64-hex-container-id>",
  "utility_image": "sha256:<64-hex-local-production-php-image-id>",
  "reserve_bytes": 268435456
}
```

Project должен совпадать с `state.json`. Имена services должны соответствовать
текущему Compose: postgres, minio, nginx, php, report-worker, outbox-worker,
report-scheduler; minio-init, если существует, тоже считается writer. Неизвестные
services, отсутствующие обязательные services и их дубликаты блокируют копию.
MinIO `/data` должен быть local named volume без driver options; bind/NFS,
распределённый MinIO и несколько storage volumes не поддерживаются этим форматом.
PostgreSQL остаётся запущенным; инструменты берутся из его же образа/контейнера.

Пример команд с fail-fast, без автоматической остановки сервисов:

```sh
(
  set -eu
  umask 077
  sh docker/release/backup.sh preflight "$STATE_DIRECTORY" "$BACKUP_CONFIG" "$BACKUP_ROOT"
)
```

`preflight` разрешён в `images_ready`: проверяет topology, tools, доступ к dump
и globals, ZipArchive, оценку размеров и свободное место. Возвращает путь к
новому неизменяемому preflight receipt, действительному 15 минут и привязанному
к project, operation ID и revision. Путь нужно сохранить только после успешной
команды; старый receipt не заменяет неудачную проверку нового состояния.

Дальнейший порядок для **будущего** release coordinator:

1. Под общей блокировкой выполнить preflight; при ошибке не начинать остановку.
2. Через `persist(dir, expected, next, { preflight: receiptPath })` перейти из
   images_ready в quiescing. Отсутствующий, просроченный или чужой receipt запрещён.
3. Закрыть HTTP ingress, остановить scheduler, outbox, queue workers, PHP и
   minio-init; проверить реальные exit codes/OOM. Затем штатно остановить MinIO.
   Одного graceful shutdown недостаточно: контейнеры должны быть остановлены.
4. Зафиксировать quiesced и создать backup. PostgreSQL не останавливать.
5. Проверить backup; `persist(..., { backup: backupPath })` допускает backup_ready
   только при совпадении source release, target operation, project и revision.
   Переход backup_ready → migrating повторно проверяет файлы и SHA-256.
   `advance()` остаётся чистой моделью; только `persist()` сохраняет переход.
6. Лишь после этого будущий coordinator сможет запускать миграции. Самих миграций,
   остановки/start сервисов и автоматического rollback этот инструмент не делает.

Готовые команды для фиксации этих двух переходов (backup уже должен существовать):

```sh
(
  set -eu
  sh docker/release/release.sh accept-backup "$STATE_DIRECTORY" "$RELEASE_MANIFEST" "$BACKUP_CONFIG" "$BACKUP_PATH"
  sh docker/release/release.sh mark-migrating "$STATE_DIRECTORY" "$RELEASE_MANIFEST" "$BACKUP_CONFIG" "$BACKUP_PATH"
)
```

`accept-backup` требует quiesced и записывает backup_ready; `mark-migrating`
требует backup_ready и записывает migrating, **не выполняя миграции**. Обе команды
используют существующую блокировку FD 9, заново проверяют backup и PostgreSQL TOC,
source/target release, project и исходную revision. Повтор команды в её целевой
фазе повторяет проверки, сохраняя байты state.json и revision. Повреждённая,
отсутствующая или чужая копия запрещена и при повторе. Пропуск фаз и обратный
переход не допускаются; current/previous не меняются. Остановка сервисов и
создание backup остаются отдельными действиями до этих команд.

Согласованная offline-копия MinIO **невозможна до остановки writers**. Поэтому
preflight блокирует начало остановки, а сбой создания backup после quiesce
блокирует дальнейшие фазы, но не отменяет уже произошедшую остановку.
`backup.sh` держит lock на время одной команды; будущий coordinator должен
удерживать ту же блокировку на протяжении всей операции, а не запускать
конкурирующие CLI-команды. API модуля можно вызывать при уже удерживаемом FD 9.

После quiesce (каталоги/переменные задаёт оператор):

```sh
(
  set -eu
  umask 077
  sh docker/release/backup.sh create "$STATE_DIRECTORY" "$BACKUP_CONFIG" "$BACKUP_ROOT" "$BACKUP_ID"
)
```

Команда возвращает путь `$BACKUP_ROOT/$BACKUP_ID`. Backup ID состоит из 1–64
строчных ASCII букв, цифр, `_` и `-`, начиная с буквы/цифры. Существующие ID
никогда не переиспользуются, в том числе после ошибки/SIGKILL: `.claim-ID`
сохраняется для разбора оператором. Каждая попытка пишет в закрытый `.partial-*`.
Файлы flush/fsync, каталог публикуется rename после записи `COMPLETE`; скрытый
partial не принимается verifier даже если содержит COMPLETE. При обычном отказе
partial удаляется; после SIGKILL он может остаться для ручного разбора.
Автоматической очистки старых резервных копий нет.

Состав копии, формат schema_version 1:

- `postgres.dump`: `pg_dump -Fc` configured database, проверенный `pg_restore --list`.
- `globals.sql`: `pg_dumpall --globals-only --no-role-passwords`; роли и другие
  cluster globals нужны для полноценного восстановления владельцев/прав.
- `minio.zip`: offline snapshot **всего** `/data`, включая `.minio.sys`, реальные
  object contents и версии, а не только bucket listing. ZipArchive входит в
  PHP-образ; helper проверяет SHA-256 содержимого каждого файла после записи.
- `metadata.json`: UTC creation time, backup ID, source release ID / Git SHA,
  target operation ID, state revision, PostgreSQL server version / immutable
  image ID / custom format, MinIO image ID / offline-zip-v1, размеры и SHA-256
  трёх data files. Для первого релиза без current используется candidate manifest
  как идентификатор baseline; происхождение уже существующих данных это не доказывает.
- `COMPLETE`: SHA-256 metadata.json. Файлы 0600, каталог 0700.

Минимальный свободный резерв — 64 MiB, задаваемый reserve_bytes. Предварительная
оценка — удвоенные размеры PostgreSQL database и MinIO volume плюс резерв;
после копирования резерв проверяется снова. Это не физическое резервирование
места: конкурирующее заполнение диска или ENOSPC приводит к отказу, а не к
успешной копии. Изолированное restore также требует места Docker и памяти для
временного PostgreSQL tmpfs. Метаданные и CLI не содержат паролей; сами data files
могут содержать персональные данные и MinIO IAM secrets. Храните их на защищённом
диске. Шифрование, offsite copy, retention и защита от потери всего VPS не добавлены.
Контрольные суммы не являются цифровой подписью: backup root доверен оператору,
его нельзя отдавать на запись другим пользователям/сценариям или изменять во время
backup/verify. Не удаляйте и не заменяйте state directory во время операций.

Перед/после копирования проверяются фактические состояния writers, timestamps
их старта/остановки, отсутствие иных running writable mounts MinIO volume и
активных SQL client sessions. Эти проверки не запрещают административный запуск
контейнеров или новое внешнее SQL-подключение между проверками. На время quiesce
оператор обязан исключить внешних writers, cron и изменение topology/volumes.
Произвольный stop/start вне release lock не поддерживается.

Проверка готовой копии и отдельный безопасный restore test:

```sh
(
  set -eu
  sh docker/release/backup.sh verify "$STATE_DIRECTORY" "$BACKUP_CONFIG" "$BACKUP_PATH"
  sh docker/release/backup.sh restore-test "$STATE_DIRECTORY" "$BACKUP_CONFIG" "$BACKUP_PATH"
)
```

Verify проверяет allowlist/типы метаданных, полный состав файлов, отсутствие
symlinks, COMPLETE, размеры, SHA-256 и PostgreSQL TOC. Restore-test создаёт новый
PostgreSQL-контейнер без сети/портов с новым tmpfs и базой `backup_verify`, вызывает
`pg_restore --exit-on-error --no-owner --no-acl`. Globals не применяются к основной
или тестовой cluster: тест подтверждает восстановимость схемы/данных, а не точное
восстановление production ownership, ACL, role passwords или tablespaces. Роли
и credentials для полного аварийного восстановления нужно восстанавливать
отдельно в чистой среде по globals/runtime configuration; такой production restore
пока не реализован. Файл globals намеренно не содержит паролей ролей.

MinIO ZIP извлекается в **новый отдельный Docker volume** с проверкой содержимого.
Path traversal, links, special file types и перезапись извлечённых файлов запрещены.
Это проверка восстановления файлов, не запуск production MinIO и не гарантия
совместимости другой версии storage format. Нормализация владельца/прав и запуск
MinIO с восстановленным backend требуют отдельной процедуры и того же image ID.
Рабочие PG/MinIO volume не используются как restore destination. Изолированные
ресурсы имеют уникальные имена/метки и удаляются после успеха и ошибки; helper
контейнеры также помечены `pizza.backup-helper`. SIGKILL самого инструмента или
потеря Docker daemon может потребовать ручного разбора оставшихся помеченных
ресурсов. Никогда не удаляйте volumes без проверки владельца и метки.

Адресные тесты (полный уже пройденный release-набор повторять не требуется):

```sh
node --test docker/release/backup.test.mjs docker/release/deploy.test.mjs
# Opt-in: локальные postgres:15-alpine, minio/minio и production PHP с ZipArchive.
BACKUP_DOCKER_TEST=1 BACKUP_TEST_PHP_IMAGE="$LOCAL_PHP_IMAGE_ID" \
  node --test docker/release/backup-docker.test.mjs
```

Docker-тест не использует текущий Compose project: создаёт свой уникальный project,
PostgreSQL/MinIO без внешней сети и собственные volumes, тестовую таблицу и S3-объект.
Проверяет реальный dump/restore, отказ при работающем MinIO, cleanup после ошибки
restore и сохранность исходных тестовых данных. Обычные unit-тесты используют
временные файлы/fake adapter; их успех не доказывает доступность реального VPS.

`reports/` содержит генерируемые XML, архивы, checksum/IDs и state-файлы;
каталог исключён из Git и backend Docker-контекста. Frontend Docker-контекст
ограничен `frontend/`, где зависимости, dist и coverage исключены отдельно.
Временные test.env/override создаются через `mkdtemp` в системном временном
каталоге и удаляются сценарием; в репозиторий их копировать не следует.
