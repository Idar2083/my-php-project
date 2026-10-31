# Release runbook

Это инструкция для будущей согласованной операции. Команды изменения состояния
ниже не являются dry-run. Локальный аудит не разрешает production deploy.
Подробности форматов и ограничений: [README](../../README.md).

## GitLab tag pipeline и SSH deploy

Реализация проверяется локально с fake transport; **production deploy на VPS не
проверен**. Покупка VPS, DNS и TLS остаются отдельной подготовкой. Формат релиза:
`vMAJOR.MINOR.PATCH`, например `v1.2.3`, без ведущих нулей и prerelease. Это
принятая для этого deploy политика; теги нельзя перемещать или переиспользовать.

Branch/MR pipeline сохраняется. Push Git-тега допускается workflow; только push
защищённого version-тега включает `deploy-production`. Git-тег и image tag — разные
идентификаторы: образы по-прежнему публикуются с CI_PIPELINE_ID, manifest фиксирует
digest, SHA и pipeline ID. Stage deploy идёт после всех проверок, интеграции,
публикации и manifest, без `needs`, обходящих этот барьер. Deploy сериализуется
`resource_group: production-deploy`; сервер дополнительно удерживает **тот же**
FD 9/flock каталога state на весь backup/continue. Job старше текущего pipeline
на сервере отклоняется. Это не сравнение semver и не механизм downgrade.

### Настройки GitLab до первого тега

1. Protected tags: защитить `v*`, разрешить создание только ответственным за
   production; точный semver дополнительно проверяют job и скрипт. Не использовать
   незакрытые правила, позволяющие другим ролям создавать те же теги.
2. Environments: защитить environment `production` и ограничить allowed deployers.
   YAML создаёт environment, но **не может установить его protected-права**.
   Если тариф GitLab не предоставляет protected environments, обязательной границей
   остаются protected tags/variables и права создания тегов; оцените эту политику
   доступа до включения автоматического deploy.
3. Добавить следующие project CI/CD variables. Все protected, scope `production`.
   File variables загружаются файлами, не строковыми путями к файлам на runner.

| Variable | Тип | Назначение |
| --- | --- | --- |
| `DEPLOY_HOST` | Variable | DNS-имя или IPv4 VPS; IPv6 этот адаптер не поддерживает |
| `DEPLOY_PORT` | Variable | SSH port, обязателен, включая стандартный 22 |
| `DEPLOY_USER` | Variable | Отдельный непривилегированный login, не root |
| `DEPLOY_ROOT` | Variable | Выделенный абсолютный каталог приложения, например `/srv/pizza`; без пробелов, точек и symlinks |
| `SSH_PRIVATE_KEY` | File | Отдельный deploy private key без passphrase; ограничить доступ, не включать debug trace |
| `SSH_KNOWN_HOSTS` | File | Проверенные host keys именно этого VPS и порта |

Не делать `ssh-keyscan` доверенным источником в deploy-job. Сверить fingerprint
через консоль провайдера/другой доверенный канал; для нестандартного порта запись
known_hosts должна соответствовать `[host]:port`. Host key checking обязателен;
ключ не передаётся в argv. Masked/hidden применять там, где GitLab поддерживает
формат значения; multiline file variable может не поддерживать masking.

Для публикации сохраняются встроенные CI_REGISTRY_* variables. Для **VPS** заранее
создать отдельный GitLab Deploy Token только с `read_registry`, выполнить login
от имени deploy-пользователя через `--password-stdin` и защитить Docker config
(или использовать credential helper). Эти credentials остаются на VPS; дополнительных
registry CI variables адаптеру не нужно. Не использовать персональный admin token
или краткоживущий CI_JOB_TOKEN как постоянный серверный login. Нужен runner с
доступным Docker daemon, как для уже существующих build/integration jobs.

### Подготовка VPS и доверенного адаптера

Создать deploy-пользователя, установить Node.js 24+, util-linux flock,
Docker/Compose и настроить доступ к локальному Docker daemon. Доступ к Docker
фактически даёт административные возможности на хосте: выделить этот доступ
только deploy identity. SSH key использовать только для этого приложения;
запретить forwarding/PTY в authorized_keys (например, опция `restrict`).

Оператор создаёт следующие каталоги, принадлежащие deploy-пользователю, mode 0700:

```text
DEPLOY_ROOT/
  releases/
  shared/
    state/
    backups/
```

На VPS из заранее просмотренного коммита установить **пять доверенных файлов**
в `DEPLOY_ROOT/deploy-tools/`: `deploy-server.sh`, `deploy-server.mjs`,
`deploy-bundle.mjs`, `manifest.mjs`, `published-manifest.mjs` из `docker/release/`.
Адаптер не загружается и не запускается из непроверенного stdin. Обновлять эти
файлы отдельно после review, совместимым комплектом; смена протокола требует
обновления адаптера до следующего тега. Скрипты запускаются через sh/node,
executable bit не требуется. Не разрешать посторонним изменять tools и каталоги.

До первого bootstrap подготовить `shared/runtime.env` (0600) с **полной** конфигурацией Compose:
параметры из существующего корневого `.env`, NGINX_PORT, APP_URL, постоянные APP_KEY и
JWT_SECRET, DB_*/POSTGRES_*, Redis/RabbitMQ/MinIO credentials. Это не копия `.env`
из CI: корневой `.env`, app/.env, .env.testing и локальные overrides не доставляются.
Не хранить runtime-секреты в CI, bundle или manifest. Подготовить ingress/TLS,
DNS, firewall, обновление сертификата и отдельную безопасную копию backup.

### Первый VPS без домена: закрытая проверка

До DNS/TLS используется только SSH-туннель. Минимальная настройка совместима
с существующими тремя Compose-файлами и `checkCompose`:
`NGINX_PORT=127.0.0.1:8080`, `APP_URL=http://127.0.0.1:8080`.
NGINX_PORT здесь — существующая Compose port specification: результатом является
один порт `127.0.0.1:8080:80`, а не публикация на всех интерфейсах. Не заменять
его просто на `8080`. Внутренние health checks продолжают обращаться к порту 80
в контейнере. Same-origin frontend использует `/api`, CORS для туннеля не нужен.
Release health checks проверяют приложение из контейнера, поэтому доступность
туннеля и фактический host bind оператор проверяет отдельно.

Дополнительный корневой `.env.example` не нужен: существующий корневой `.env`
документирует публичные Compose-параметры, `.env.local` содержит локальные
секреты и загружается после него через `--env-file`. `app/.env.example` остаётся
шаблоном Laravel для локального `app/.env`.

Для release deployment единственный источник production-настроек —
`/srv/pizza/shared/runtime.env` (0600, владелец deploy). Это уже предусмотренный
серверным адаптером механизм, а не дополнительная копия локального окружения.
Адаптер не доставляет локальные `.env`/`.env.local`/`app/.env`, создаёт пустой
bundle/.env и загружает runtime.env через `--env-file`; переменные приложения
из shell исключены. Production Compose передаёт настройки Laravel через
container environment, поэтому отдельный `app/.env` в production не нужен.
Не хранить production-секреты в отслеживаемом корневом `.env`.

Для первого закрытого запуска установить отдельно просмотренный
`docker/release/create-runtime.mjs` в `/srv/pizza/deploy-tools/` и выполнить
от deploy-пользователя после подготовки каталога shared (0700):

```sh
node /srv/pizza/deploy-tools/create-runtime.mjs /srv/pizza/shared 8080
stat -c '%a %U:%G %n' /srv/pizza/shared/runtime.env
```

Это отдельный операторский инструмент, не часть delivery bundle. CI запускает
только его тесты; deploy/coordinator/bootstrap генератор не вызывают. Он не
запускает Docker и не читает локальные env-файлы. Создаёт один runtime.env:
независимые случайные APP_KEY/JWT_SECRET/пароли, согласованные DB_*/POSTGRES_*
и loopback-доступ. APP_KEY — `base64:` + base64 от 32 случайных bytes.

Генератор требует принадлежащий текущему пользователю приватный каталог без
symlinks, записывает полный файл 0600 во временный каталог 0700 и публикует
через exclusive hard link с fsync. Существующий файл никогда не заменяет;
symlink или небезопасные права отклоняет. Существующий обычный файл 0600
текущего пользователя сохраняет без проверки правильности его содержимого.
Секреты не передаются через argv и не выводятся. При ошибке после публикации
файл уже может существовать: сначала проверить его наличие и права, не удалять
и не генерировать новые ключи вслепую.

До первого bootstrap проверить конфигурацию по таблице ниже через
`docker compose ... config --quiet` с runtime.env и manifest image references.
Сам bootstrap не создаёт runtime.env; без него первый запуск невозможен.
При повторном deploy используется тот же файл, генератор повторно не нужен.
Его повторный ручной запуск сохраняет существующий файл даже при другом порте;
это не инструмент изменения порта или ротации credentials. Не запускать
`key:generate`/`jwt:secret` для уже развёрнутого приложения.
Не выводить секреты в терминал, логи или аргументы команд.

Полный набор входных переменных runtime.env:

| Переменные | Согласование / назначение |
| --- | --- |
| `NGINX_PORT`, `APP_URL` | `127.0.0.1:8080` и `http://127.0.0.1:8080`; при другом порте изменить оба и локальный порт туннеля |
| `APP_KEY`, `JWT_SECRET` | Постоянный Laravel AES-256 key (`base64:` + 32 bytes) и независимый случайный JWT secret |
| `DB_CONNECTION`, `DB_HOST`, `DB_PORT` | `pgsql`, `postgres`, `5432` — внутренний адрес, не VPS IP |
| `DB_DATABASE`, `DB_USERNAME`, `DB_PASSWORD` | В точности равны `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` |
| `POSTGRES_DB`, `POSTGRES_USER`, `POSTGRES_PASSWORD` | Инициализация нового PostgreSQL volume; смена env не меняет уже существующие роли/пароли |
| `REDIS_PASSWORD` | Один пароль для Redis, Laravel и migration isolation lock; host/port фиксированы Compose как `redis:6379` |
| `PRODUCTS_CACHE_TTL` | `3600`; основной cache остаётся database, только migration использует Redis |
| `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | Compose передаёт те же credentials RabbitMQ и Laravel; host `rabbitmq`, port `5672`, vhost `/`, topology использует application defaults |
| `MINIO_ROOT_USER`, `MINIO_ROOT_PASSWORD`, `MINIO_BUCKET` | Compose автоматически задаёт Laravel `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_BUCKET` из этих значений; отдельно AWS credentials не задавать |
| `POSTGRES_PORT`, `REDIS_PORT`, `RABBITMQ_PORT`, `RABBITMQ_MANAGEMENT_PORT`, `MINIO_PORT`, `MINIO_CONSOLE_PORT` | Только interpolation базового dev Compose; production удаляет все эти port mappings |

Compose фиксирует `APP_ENV=production`, `APP_DEBUG=false`, `LOG_CHANNEL=stderr`,
`AWS_DEFAULT_REGION=us-east-1`, `AWS_ENDPOINT=http://minio:9000`,
`AWS_USE_PATH_STYLE_ENDPOINT=true`. MAIL_* не передаются production Compose;
внешняя почта сейчас не настроена. PHP/nginx images приходят исключительно из
manifest. Production override отклоняет пустые обязательные параметры.
Bootstrap дополнительно сверяет DB_* с POSTGRES_* до создания ресурсов.

Для проверки реального runtime использовать coordinator check (после появления
state) либо `docker compose ... config --quiet`; никогда не печатать `config`,
`config --environment`, `docker inspect` или env целиком. Coordinator разбирает
Compose JSON внутри процесса, без вывода; launch/bootstrap `compose.json`
**содержит секреты** и хранится только в приватном state (0600/0700). Его нельзя
копировать в bundle, CI artifacts или диагностические вложения. Docker-admin
по своей природе может читать container environment; права deploy ограничивают
доступ к этому механизму, но не скрывают секреты от администратора Docker.

На пустом VPS bootstrap требует заранее доступных локально инфраструктурных
images: `postgres:15-alpine`, `redis:7-alpine`,
`rabbitmq:3.13-management-alpine` и собственные community MinIO/mc ниже.
Bootstrap использует `--pull never` для них; автоматически получает только
application digest images из manifest. Загрузку инфраструктуры согласовать отдельно,
проверить архитектуру и доступность; image IDs/RepoDigests сохранить в операторской
записи. Теги PostgreSQL/Redis/RabbitMQ остаются изменяемыми.

### Собственные community MinIO и mc (подготовка, не deploy)

Официальные community repositories недоступны по проверенным Docker Hub/Quay
адресам. Рецепты `docker/minio/Dockerfile.server` и `Dockerfile.mc` собирают
исходники непосредственно из официальных Git repositories с проверкой commit SHA:

| Компонент | Официальный тег | Commit SHA |
| --- | --- | --- |
| [MinIO](https://github.com/minio/minio) | `RELEASE.2025-10-15T17-29-55Z` | `9e49d5e7a648f00e26f2246f4dc28e6b07f8c84a` |
| [mc](https://github.com/minio/mc) | `RELEASE.2025-08-13T08-35-41Z` | `7394ce0dd2a80935aded936b09fa12cbb3cb8096` |

Перед разрешением сборки отдельно подтвердить tag→SHA через GitHub API и
manifest/config баз через Docker Registry API, без загрузки слоёв. Исходники
upstream и первичные ответы registry в репозитории не сохранены, поэтому локальное
ревью не подтверждает соответствие приведённых значений официальным источникам.
Оба FROM предполагают **linux/amd64 manifest**, не index:

| База | Manifest digest |
| --- | --- |
| Docker Official Image `golang:alpine`, Go `1.27.3` | `sha256:bff16a94c0b4b6d9642581e2a3aa81beb3edb940b2f5a3aac1d22c6a68cb7747` |
| Docker Official Image `alpine:3.22` | `sha256:dc92f017beea8e7f43263073d717f7bc011228c95d5312e440deb4d035bb4eec` |

Go выбран новее указанных upstream toolchain 1.24.8/1.23.10. У сохранившихся
trial-образов проверены `--version`, release/commit labels и runtime Go 1.27.3
linux/amd64; MinIO/mc contract и изолированный backup/restore прошли 2026-10-31.
Это подтверждает проверенное поведение этих image IDs. В сохранённом OCI archive
обнаружены BuildKit SLSA v1 attestations: subject соответствует amd64 manifest,
dependency digests совпадают с обеими базами выше, сохранены timestamps сборок.
Attestations не проверены независимой подписью; они не заменяют исходные build logs
и доказанную связь с текущими Dockerfile. Подробная операторская
запись и сценарий публикации хранятся приватно вне Git и `/tmp`.
`GOTOOLCHAIN=local` исключает автоматическую подмену компилятора,
`GOAMD64=v1` не требует расширенного CPU ISA, `CGO_ENABLED=0` исключает C toolchain.
Модули проверяются через `go mod verify`; изменение go.mod/go.sum отклоняется.
Сборки НЕ объявляются воспроизводимыми: APK indexes и версии прямых/транзитивных
пакетов ОС не зафиксированы. Go dependency graph берётся из go.mod/go.sum указанного
commit, но полнота фиксации транзитивных модулей ещё требует проверки исходников;
go mod verify не является проверкой уязвимостей. Доступность Git/Go modules,
настройки proxy/checksum service, версия BuildKit и timestamps OCI не зафиксированы.
Две независимые сборки бинарников и OCI images не сравнивались. Community upstream
архивирован; своя сборка не обеспечивает будущие security fixes. Сохранить LICENSE,
CREDITS и соответствующий исходный код для соблюдения условий upstream лицензии.

Только после отдельного разрешения, локально из корня репозитория:

```sh
docker buildx build --platform linux/amd64 --load \
  -f docker/minio/Dockerfile.server \
  -t pizza-infra/minio-community:RELEASE.2025-10-15T17-29-55Z docker/minio
docker buildx build --platform linux/amd64 --load \
  -f docker/minio/Dockerfile.mc \
  -t pizza-infra/mc-community:RELEASE.2025-08-13T08-35-41Z docker/minio
MINIO_IMAGE_DOCKER_TEST=1 node --test docker/minio/images.test.mjs
BACKUP_DOCKER_TEST=1 \
  BACKUP_TEST_MINIO_IMAGE=pizza-infra/minio-community:RELEASE.2025-10-15T17-29-55Z \
  BACKUP_TEST_PHP_IMAGE="${LOCAL_PHP_IMAGE_ID:?Set the local PHP utility image ID}" \
  node --test docker/release/backup-docker.test.mjs
```

Первый тест проверяет оба health endpoints, server `/data` с read-only root,
запись в `/data` и `/tmp`, CA bundle, shell, штатный HOME без MC_CONFIG_DIR override,
повторное создание bucket и S3 запись/чтение. `/tmp` имеет nosuid,nodev, как в restore-test.
Второй проверяет настоящий offline backup/restore, включая версии объектов.
PHP utility image с ZipArchive/AWS SDK должен быть подготовлен отдельно.
Затем выполнить существующую изолированную bootstrap/recovery репетицию ниже
с локальными production PHP/Nginx digest images. Эти проверки не обращаются к VPS.
До их успеха совместимость новых образов с production не подтверждена.

Доставка — отдельная согласуемая операция. После проверок опубликовать образы
в собственный доверенный registry (например, project GitLab Registry), используя
новые непереиспользуемые tags. Получить RepoDigests **после публикации**, сохранить
их вместе с локальными image IDs, recipe revision, исходными SHA и build logs.
Финальные digests до сборки/публикации неизвестны; не подставлять вымышленные значения.
На VPS заранее получить обе точные digest references через read_registry access.
Не присваивать своим сборкам имена `minio/minio` или `minio/mc`.

Compose defaults — локальные имена сборок выше. Для production перед bootstrap
оператор отдельно добавляет две несекретные ссылки в уже существующий runtime.env:
`MINIO_IMAGE=<own-registry>/minio-community@sha256:<published-digest>` и
`MINIO_MC_IMAGE=<own-registry>/mc-community@sha256:<published-digest>`.
Существующие ключи/пароли не менять; генератор runtime повторно не вызывать.
Значения только из shell не дойдут до release Compose: `state.mjs` намеренно
отбрасывает такие overrides. Проверить `config --quiet` с реальным runtime и
image refs из application manifest; содержимое runtime не печатать.

Manifest по-прежнему содержит только PHP/Nginx. Новые имена инфраструктуры
проходят неизменённый checkCompose; build/bind mounts по-прежнему запрещены.
Bootstrap фиксирует локальные image IDs всех сервисов в приватном compose.json.
Backup сохраняет ID исходного MinIO; restore-test запускает именно его с
`--network=none --read-only`, writable `/data` и `/tmp`, временными root credentials.
Хранить этот образ в registry и отдельном `docker image save` архиве с SHA-256:
восстановление не должно зависеть от повторной сборки или существования upstream.
На новом хосте заранее восстановить тот же image ID; также нужны PostgreSQL,
PHP utility image, bundle, runtime и state/backup согласно recovery runbook.
Не удалять старый MinIO image и не обновлять storage image вместе с recovery.

### Публикация MinIO/mc для CI (отдельная разрешаемая операция)

CI не собирает и не публикует эти инфраструктурные образы автоматически. Перед
первым pipeline отдельно разрешить следующие действия в GitLab Registry:

1. Собрать оба рецепта для linux/amd64 по зафиксированным SHA выше, под новыми
   локальными tags. Сохранить recipe revision/полный diff, хеши Dockerfile, базовые
   digests, версии Go, build logs и image IDs. Уже проверенные image IDs повторно
   не пересобирать без причины. Сверить recipes, labels и бинарные версии;
   отсутствие исходных build logs/attestation явно записать как ограничение,
   не выдавать текущий snapshot за доказанное происхождение образа.
   Изменение любого рецепта, upstream
   commit или базы требует новых tags и повторных проверок. Побитовая
   воспроизводимость не доказана, в частности APK packages остаются плавающими.
2. Перед публикацией выполнить `docker/minio/images.test.mjs` с явными
   `MINIO_TEST_SERVER_IMAGE` / `MINIO_TEST_CLIENT_IMAGE` и
   `MINIO_IMAGE_DOCKER_TEST=1`, затем существующий изолированный backup/restore
   тест с тем же server image ID. При ошибке ничего не публиковать. Сохранить логи
   и неизменные проверенные IDs; существующие тома/production не использовать.
3. Выбрать два новых непереиспользуемых tags в репозиториях проекта:
   `$REGISTRY_IMAGE/minio-community` и `$REGISTRY_IMAGE/mc-community`.
   `REGISTRY_IMAGE` — реальное значение CI_REGISTRY_IMAGE из настроек проекта,
   не локальное имя и не пример hostname. В tag включить upstream release,
   recipe revision и уникальный build ID; проверить отсутствие tag в Registry.
   Ограничить запись и исключить tags из cleanup policy; при доступности настроить
   immutable/protected container tags. Не перемещать уже опубликованные tags.
4. Только после разрешения публикации выполнить login через `--password-stdin`
   с ограниченными read_registry/write_registry credentials и временным
   DOCKER_CONFIG. Не передавать credentials в build args/образ и не включать
   shell tracing. Опубликовать **проверенные IDs**, без повторной сборки:

   ```sh
   docker tag "${VERIFIED_MINIO_ID:?}" "${REGISTRY_IMAGE:?}/minio-community:${SERVER_PUBLISH_TAG:?}"
   docker tag "${VERIFIED_MC_ID:?}" "$REGISTRY_IMAGE/mc-community:${CLIENT_PUBLISH_TAG:?}"
   docker push "$REGISTRY_IMAGE/minio-community:$SERVER_PUBLISH_TAG"
   docker push "$REGISTRY_IMAGE/mc-community:$CLIENT_PUBLISH_TAG"
   docker image inspect "$REGISTRY_IMAGE/minio-community:$SERVER_PUBLISH_TAG" --format '{{json .RepoDigests}}'
   docker image inspect "$REGISTRY_IMAGE/mc-community:$CLIENT_PUBLISH_TAG" --format '{{json .RepoDigests}}'
   ```

   Сохранить реальные RepoDigests и соответствие проверенным image IDs, отдельно
   от OCI config digest/index/amd64 manifest. Если опубликован index, проверить его
   linux/amd64 descriptor. Сохранить исходники/лицензии и image save архив согласно
   требованиям восстановления выше. Digest нельзя вывести из имени локального tag.
5. Создать в GitLab Settings → CI/CD → Variables две **несекретные** переменные:
   `MINIO_CI_IMAGE` = полный опубликованный
   `CI_REGISTRY_IMAGE/minio-community@sha256:<actual-published-digest>` и
   `MINIO_MC_CI_IMAGE` = `CI_REGISTRY_IMAGE/mc-community@sha256:<actual-published-digest>`.
   Здесь CI_REGISTRY_IMAGE в значении заменить буквальным адресом проекта; не
   полагаться на nested variable expansion. Scope `*`, доступны branch/MR jobs
   (не protected-only), без masking. Не менять protected production secrets.
   Пустые переменные и tags вместо digest намеренно останавливают minio-images job.

Отдельный job minio-images сначала валидирует ссылки, затем получает оба digest images и запускает
существующий MinIO/mc contract test на локальном Docker daemon через Node tooling
image. Проверяются read-only server/client, health, CA/HOME, bucket-init и S3
запись/чтение. Ошибка блокирует backend tests, production integration и публикацию
production PHP/Nginx, но не сборку/публикацию служебного CI PHP image. Frontend,
release-checks и production-config имеют needs: []; PHP static jobs зависят только
от build, backend tests — от build и minio-images. Production integration/publish,
manifest и deploy сохраняют полный stage barrier без обходящих его needs. Helper
получает через stdin только публичный тест; Registry credentials не передаются.
Backend job использует `MINIO_CI_IMAGE` как service `minio`, PostgreSQL/RabbitMQ и
прежний `wait-services.php` (head/create bucket через AWS SDK), затем Laravel tests.
Production integration на своём runner заранее получает те же private digest
images и передаёт их Compose как MINIO_IMAGE/MINIO_MC_IMAGE; credentials остаются
в job, не в test helper. Application publish/manifest/protected-tag deploy gates
не изменены. Нужен linux/amd64 runner с доступным Docker daemon/socket.

Для same-project Registry предусмотрены существующие встроенные CI_REGISTRY_*
credentials и стандартная авторизация Runner для services по CI_JOB_TOKEN;
долгоживущий токен для CI заранее добавлять не требуется. Доступ не подтверждён:
в GitLab UI проверить, что Registry включён, runner доступен для unprotected
branch/MR refs, обе несекретные image variables имеют scope * и не protected-only,
а пользователь запуска имеет право чтения private images (как минимум Reporter).
Проверить отсутствие конфликтующего DOCKER_AUTH_CONFIG и настройки job-token
access; fork MR pipelines не считать автоматически авторизованными в Registry
родительского проекта и не выдавать им постоянные write credentials. Первый согласованный
pipeline после публикации ещё должен подтвердить фактический Runner access. См. [GitLab Registry authentication](https://docs.gitlab.com/user/packages/container_registry/authenticate_with_container_registry/)
и [private images/services](https://docs.gitlab.com/ci/docker/using_docker_images/).
Пока образы не опубликованы и обе переменные не настроены, CI-конфигурация
подготовлена, но новый pipeline не готов к успешному выполнению.

#### Локальная подготовка и единая финальная отправка

Операторский `publish.py`, его исходная версия, mock-тесты и результаты проверок
хранятся в приватном долговременном каталоге вне checkout и `/tmp`. Не включать
их вместе с image archives, runtime/credentials или build evidence в Git.
Текущий инструмент имеет два явных режима (путь задаёт оператор):

```sh
# Offline: проверка двух закреплённых IDs/версий/recipes и резервное копирование.
python3 "$MINIO_PUBLICATION_TOOL" --prepare "$MINIO_PUBLICATION_STORAGE"
# Только после отдельного разрешения публикации, подтверждения Registry path
# и исключительного окна записи либо immutable tags:
REGISTRY_PROJECT_CONFIRMED=registry.gitlab.com/jihannaxz1/pizza-backend \
REGISTRY_EXCLUSIVE_PUBLICATION=yes \
  python3 "$MINIO_PUBLICATION_TOOL" --publish "$MINIO_PREPARED_EVIDENCE"
```

`--prepare` не обращается к Registry и не запрашивает credentials. Он сохраняет
архив с SHA-256, проверяет полный OCI-граф (index, manifests, configs, layers и
attestations) без `docker load`, записывает
версии, inspect/history, recipes, HEAD/diff и копию самого инструмента. Хранилище
принадлежит оператору, mode 0700; для чувствительных файлов используется umask 077.
`--publish` повторно проверяет backup/IDs/recipes, запрашивает существующие
credentials только в интерактивном терминале и использует временный Docker config.
Оба режима фиксируют Docker daemon `/var/run/docker.sock`.

Перед каждым push проверяется отсутствие тега; запись `push_started_result_unknown`
сохраняется атомарно **до** команды. После push проверяются digest реального remote
index, amd64 manifest/config digest, pull по digest, локальный image ID/RepoDigest
и неизменность тега. У этих образов Docker containerd store использует OCI index
как `.Id`; его нельзя сравнивать с config digest. Push сохраняет исходный index
и attestations, без `--platform`, который отбросил бы их. Даже если digest
локального index совпадёт с remote, Registry reference принимается только после
реального GET/проверки manifest bytes и успешного pull, а не из локального `.Id`.
Только успех обоих образов создаёт `ci-image-values.json`; GitLab variables инструмент
не меняет. Ошибка/прерывание сохраняет `stopped_requires_reconciliation`, состояния
каждого образа и уже полученные digests. Два push не атомарны; повторный запуск
этой операции запрещён автоматически. После сбоя отдельно разрешить read-only
сверку двух сохранённых тегов в Registry с ожидаемыми config IDs и проверку digest
pull: не повторять push и не удалять частично опубликованный образ вслепую.
После SIGKILL состояние перед push остаётся неопределённым; временный auth-каталог
может потребовать отдельной безопасной очистки. Обычные ошибки очищают его.
Локальная блокировка предотвращает конкурирующее выполнение одной операции,
но исключительное окно/immutable tags по-прежнему нужны против других publishers.

Перед финальным commit завершить все правки и локальные проверки. Публикация
инфраструктуры и настройка двух CI-переменных требуют отдельных разрешений;
их следует завершить до финального Git push, который создаёт branch/MR pipeline.
Затем одним согласованным commit/push отправить полный набор исходников, тестов
и документации. Промежуточные commit/push и Git tags для подготовки не выполнять.

Production integration сначала запускает `archive-production-source.sh`: HEAD
должен совпадать с `CI_COMMIT_SHA`, все новые MinIO/CI-файлы должны отслеживаться,
tracked diff и untracked файлы запрещены. Ignored reports не мешают. Затем
`git archive HEAD` передаёт полный зафиксированный checkout. До финального commit
локальная рабочая директория намеренно не проходит gate; новые файлы не попадут
в архив старого HEAD. Не обходить это копированием произвольного dirty checkout.
Helper сверяет MinIO/mc digest references с полученным Compose перед сборкой.
Production release получает те же явно выбранные ссылки через существующий
runtime.env; application manifest остаётся PHP/Nginx. На существующем production
смена storage images требует отдельной операции, не входит в публикацию для CI.

После согласованного bootstrap открыть туннель с рабочей станции отдельным
операторским SSH-ключом с разрешённым forwarding:

```sh
ssh -o StrictHostKeyChecking=yes -o ExitOnForwardFailure=yes -N \
  -L 127.0.0.1:8080:127.0.0.1:8080 deploy@149.154.64.169
```

Открывать `http://127.0.0.1:8080`, проверять `/up` и `/api/products`. CI deploy
key с `restrict` не подходит для туннеля; не снимать его ограничения ради
проверки. Не настраивать forwarding/SSH/firewall автоматически. До первого
запуска проверить версию Docker Engine (для loopback publishing нужна 28+;
старые версии имели ограничение изоляции localhost в общей L2-сети;
[документация Docker](https://docs.docker.com/engine/network/port-publishing/)).
HTTP внутри SSH-туннеля не означает настроенный публичный HTTPS. Публичный
запуск требует отдельной проверки домена, DNS, TLS/renewal и ingress.

### Доставка, первый bootstrap и повтор

CI сверяет Git-тег (включая annotated tag) с CI_COMMIT_SHA. Manifest сверяется
с IDs/digests из evidence **этого pipeline**. Файлы Compose/coordinator берутся
через `git show SHA:path` по фиксированному allowlist; произвольные image variables
не являются входом deploy. SHA-256 защищает целостность передачи по аутентифицированному
SSH, но не является отдельной цифровой подписью и не защищает от компрометации CI.

JSON bundle передаётся через stdin SSH, без tar/extract и без секретов. Сервер
проверяет checksum, identity, состав/хеши файлов, ограничения путей и ownership,
затем атомарно публикует `releases/TAG-PIPELINE_ID`. Пустой `.env` создаётся самим
адаптером только для совместимости интерфейса Compose; параметры берутся из
серверного runtime.env. Повтор доставки принимает только идентичные файлы.

При отсутствии `state.json` job оставляет проверенный bundle и **завершается
ошибкой без запуска сервисов**. Первый bootstrap всегда ручной. После проверки
bundle, проекта, runtime, Docker login и наличия infrastructure/tooling images
оператор от имени deploy-пользователя задаёт локальные переменные (не секреты):

```sh
STATE_DIRECTORY="$DEPLOY_ROOT/shared/state"
BACKUP_ROOT="$DEPLOY_ROOT/shared/backups"
RUNTIME_ENV="$DEPLOY_ROOT/shared/runtime.env"
COMPOSE_BUNDLE="$DEPLOY_ROOT/releases/$RELEASE_TAG-$RELEASE_PIPELINE_ID"
RELEASE_MANIFEST="$COMPOSE_BUNDLE/release.json"
sh "$COMPOSE_BUNDLE/docker/release/release.sh" bootstrap "$STATE_DIRECTORY" \
  "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV" "$PROJECT" "$BACKUP_ROOT"
```

PROJECT — постоянное имя нового Compose проекта, RELEASE_TAG/RELEASE_PIPELINE_ID —
идентификаторы доставленного релиза. Следовать ограничениям bootstrap ниже;
не регистрировать существующие данные вручную. После **успешного** bootstrap
установить его backup settings в фиксированный серверный путь:

```sh
install -m 600 "$STATE_DIRECTORY/bootstrap/backup-settings.json" \
  "$DEPLOY_ROOT/shared/backup-settings.json"
```

Повторить только deploy-job того же pipeline: coordinator проверит current и
readiness, не повторяя миграции. Не пересоздавать весь pipeline под тем же image
tag: существующий preflight публикации намеренно запрещает его перезапись.
Для следующего version-тега автоматический адаптер вызывает существующие
`backupRelease` → `continueRelease`, эквивалентные `release.sh backup` → `continue`.
Все прежние backup/restore-test, migration receipts, readiness и commit гарантии
сохраняются; `current` управляется только coordinator, symlink current не вводится.

### Ошибки и результат

- Успех job означает подтверждённое завершение coordinator/readiness. Проверить
  `release.sh status`, ожидаемый current/phase idle и внешний SPA/API по HTTPS.
  Доступность публичного DNS/HTTPS job дополнительно не доказывает.
- Ошибка до полной доставки/валидации не запускает coordinator. Частичный JSON
  отклоняется; staging-каталог не используется как релиз. Не удалять готовые releases
  и журналы; повторить job с теми же artifacts после исправления SSH/диска.
- После разрыва SSH не считать remote process остановленным. Проверить status/lock;
  повтор либо откажет из-за общей блокировки, либо продолжит сохранённые receipts.
- Ошибка backup блокирует миграции; ошибка миграции или readiness сохраняет
  состояние. Повтор не должен повторно запускать failed migration task.
- Job **никогда автоматически не вызывает rollback/recover**. До миграций возможен
  обычный rollback, после возможного изменения схемы — явный snapshot recovery
  согласно разделам ниже, с оценкой потери изменений после backup.
- После recovery обновить `shared/backup-settings.json` из restore/backup-settings.json
  согласно recovery runbook; для повтора самого recovery сохранить original settings.
- Manifest и publication evidence хранятся в GitLab artifacts 90 дней; releases,
  source bundles и backup на сервере сохраняются отдельно, без автоматического удаления.
  Для старого повтора с истёкшими artifacts требуется отдельная проверенная процедура,
  не обход валидации и не произвольная подстановка digest.

Локальная проверка (без SSH-соединений):

```sh
node --test docker/release/deploy-ssh.test.mjs
```
## Предусловия

- Linux, Node.js 24+, util-linux flock, Docker/Compose с поддержкой `!reset` и
  `!override`; доверенные PATH, Docker daemon и Compose bundle.

- Для обновления существующая установка зарегистрирована корректным `state.json`;
  project и current соответствуют реальным контейнерам и manifest. Новую пустую
  установку регистрирует `bootstrap` ниже. Adoption рабочей установки не поддерживается.
- Каталог состояния и backup root принадлежат оператору и имеют права 0700.
  State/config/journals имеют права 0600. Каталог состояния нельзя заменять:
  flock привязана к inode. Все команды используют один каталог и daemon.
- Bundle содержит публичный `.env` и три Compose-файла из нужного коммита;
  runtime.env и backup config хранятся отдельно. Согласованы DB_* / POSTGRES_*,
  MINIO_ROOT_* / AWS_*, APP_KEY и JWT_SECRET; секреты не выводить через compose config.
- PHP_IMAGE/NGINX_IMAGE поступают из проверенного release manifest с digest,
  а не из тегов. Сохранены локальные образы current и candidate, backup tooling
  images. Pull возможен только в prepare-backup на фазе prepared.
- Внешние writers остановлены организационно. Lock не блокирует ручной SQL,
  Docker, S3-клиенты или другие процессы. PostgreSQL и MinIO копируются при
  остановленных writers; Redis/RabbitMQ не входят в backup, очереди сохраняются
  в существующих томах. Нельзя очищать их как часть релиза.
- Production требует непустой APP_URL. Только release-migration использует
  CACHE_STORE=redis; cache store приложения и JWT blacklist не меняется.
  Redis готов до `migrate --isolated=75`: cache_locks в пустой БД не требуется.
  Все release-миграции используют тот же Redis/prefix; не запускать ручные
  миграции с другим cache store параллельно coordinator.

## Первая установка на пустом проекте

`bootstrap` — подготовка к тому же backup/continue coordinator, под общей FD 9 /
flock на всю команду. Это изменяющая операция, включая настоящие миграции.
Не использовать её для регистрации существующих данных или контейнеров.

Оператор заранее готовит проверенный manifest, Compose bundle того же коммита
(три Compose-файла и пустой `.env`, как при SSH-доставке) и заранее подготовленный
runtime.env **вне bundle/Git**, mode 0600.
Нужны все DB_*/POSTGRES_* параметры с одинаковыми database/user/password,
APP_KEY, JWT_SECRET, APP_URL, Redis/RabbitMQ/MinIO credentials и MINIO_BUCKET.
APP_URL — внешний URL со схемой; для HTTPS дополнительно требуется настроить
TLS/proxy. Непустой APP_URL сам по себе не доказывает доступность HTTPS.
Не выводить `docker compose config` без `--quiet` и содержимое runtime.env.

PROJECT — новое постоянное имя Compose проекта (строчные буквы/цифры, `_`, `-`).
STATE_DIRECTORY и BACKUP_ROOT — новые абсолютные пути на локальной файловой
системе; родительские каталоги принадлежат оператору. Не переиспользовать каталог
состояния другого проекта. Для одного проекта все команды и операторы обязаны
использовать один STATE_DIRECTORY. Не запускать Compose вручную параллельно.
Infrastructure/tooling images из bundle (PostgreSQL, Redis, RabbitMQ, MinIO и mc)
должны быть заранее доступны локально; bootstrap их не скачивает. Bootstrap
проверяет и получает PHP/Nginx по manifest digest перед созданием ресурсов,
фиксирует локальные image IDs всех сервисов в закрытом compose.json.

Только при первой подготовке каталогов (существующий путь вызовет отказ mkdir):

```sh
(
  set -eu
  umask 077
  : "${STATE_DIRECTORY:?}" "${BACKUP_ROOT:?}"
  mkdir -m 700 -- "$STATE_DIRECTORY"
  mkdir -m 700 -- "$BACKUP_ROOT"
)
```

Первый запуск и повтор после сбоя — **одна и та же команда**, с теми же файлами:

```sh
(
  set -eu
  umask 077
  sh docker/release/release.sh bootstrap "$STATE_DIRECTORY" \
    "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV" "$PROJECT" "$BACKUP_ROOT"
  sh docker/release/release.sh status "$STATE_DIRECTORY"
)
```

До первой мутации проверяются отсутствие state и всех контейнеров/томов/сетей
проекта, в том числе orphan volumes; external/custom storage не принимается.
Bootstrap journal привязывает project, manifest, bundle, конфигурацию и backup
root. Создаются остановленные application placeholders; стартуют только
PostgreSQL, Redis, RabbitMQ, MinIO и одноразовый minio-init. После health и создания
bucket проверяется отсутствие пользовательских таблиц/представлений/sequences
в PostgreSQL. Затем атомарно регистрируется state с current=null и создаётся
`$STATE_DIRECTORY/bootstrap/backup-settings.json` с IDs контейнеров и utility
image. Это регистрация исходного состояния, ещё не успешного релиза.

Далее обычный coordinator останавливает writers/MinIO, создаёт baseline backup
и выполняет изолированный restore-test. Обычный continue запускает единственный
журналируемый migration container, проверяет exit 0, поднимает зависимости/PHP,
readiness, workers и последним Nginx. Только после health/API current становится
manifest, previous остаётся null; cleanup и success receipt завершают команду.

Безопасные повторы и отказы:

- До state.json повтор bootstrap сверяет journal, созданные контейнеры и стартовые
  receipts; повторно не создаёт/не запускает наблюдённые ресурсы. После SIGKILL
  возможно завершить запись receipt по фактическому состоянию контейнера.
- После state.json bootstrap продолжает обычные backup/continue фазы. Полностью
  завершённый bootstrap повторяет health/недостающий cleanup, не backup и миграции.
- Ошибка backup блокирует миграции. Ошибка migration container сохраняется:
  повтор не перезапускает failed task. Ни current, ни success receipt не публикуются.
- При отказе dependency readiness ingress/workers ещё не запускаются; повтор
  после исправления внешней причины использует завершённую миграцию. Отказ
  финального API health может оставить Nginx запущенным, current не фиксируется.
- Смена manifest/runtime/bundle, исчезновение/замена/перезапуск контейнера,
  OOM, чужие ресурсы или непустая исходная БД требуют разбора, а не удаления
  journal/state, очистки БД или нового каталога состояния.

Bootstrap не делает автоматический rollback схемы. При failed/неоднозначной
миграции применяются правила recovery ниже; первого current ещё нет, старую
версию запускать нельзя. Для последующих обычных обновлений используйте
prepare-backup/backup/continue с BACKUP_CONFIG из bootstrap/backup-settings.json;
сохраняйте тот же state directory, project и рабочие тома. После нового релиза
старый bootstrap manifest повторно не допускается.

Адресные проверки bootstrap (без Docker daemon):

```sh
node --test docker/release/bootstrap.test.mjs
node --test docker/release/release.test.mjs docker/release/deploy.test.mjs
```

Полная проверка первой установки на новых изолированных Docker-ресурсах:

```sh
BOOTSTRAP_DOCKER_TEST=1 \
BOOTSTRAP_TEST_PHP_IMAGE="$PHP_IMAGE" \
BOOTSTRAP_TEST_NGINX_IMAGE="$NGINX_IMAGE" \
  node --test docker/release/bootstrap-docker.test.mjs
```

PHP_IMAGE/NGINX_IMAGE здесь — **уже имеющиеся локально digest references** формата
manifest с production PHP/Nginx. Тест не обращается к Registry и не собирает
образы; инфраструктурные images из Compose тоже нужны локально. Он создаёт
новые случайные project/volumes, synthetic runtime.env, loopback HTTP-порт,
запускает тот же bootstrap/backup/continue и реальный Laravel на пустой БД,
проверяет Redis mutex (конкурентный migrate возвращает 75), повтор без изменения
state и удаляет только свои ресурсы. Это проверка release-протокола на выбранных
images, а не доказательство свежей сборки текущего Git SHA или работы VPS.
Fake-тесты отдельно проверяют failed migration, отказ readiness, SIGKILL,
изменение конфигурации и общую блокировку.

## Команды и границы

Переменные ниже — заранее проверенные абсолютные пути; manifest относится к
candidate, включая rollback. Не менять файлы между командами. Перед действием:

```sh
sh docker/release/release.sh status "$STATE_DIRECTORY"
sh docker/release/release.sh check "$STATE_DIRECTORY" \
  "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV"
```

`check` проверяет только manifest/state/разрешённую Compose-конфигурацию;
он не доказывает доступность образов, корректность backup или health.

| Команда | Допустимый вход | Действия и подтверждённый результат |
| --- | --- | --- |
| `prepare-backup` | новая операция / prepared → quiesced | Проверки, pinned image acquisition, preflight, последовательная остановка writers; quiesced после exit 0 без OOM |
| `backup` | ранние фазы → backup_ready | Та же подготовка; PostgreSQL dump/globals и offline MinIO snapshot, hashes/TOC и изолированный restore-test |
| `continue` | backup_ready или фаза той же операции с launch journal | migrating → migrated → starting → verified → committed; атомарное обновление current/previous, затем release_succeeded receipt/event |
| `rollback` | backup_ready и есть current | rolling_back, запуск сохранённых проверенных контейнеров current, health; current/previous неизменны, operation очищается, rollback_succeeded |
| `rollback` | migrating / migrated / starting / verified | recovery_required, остановка проверенных writers; ненулевой код, без отката схемы и запуска прежней версии |

Последовательность успешного релиза:

```sh
sh docker/release/release.sh prepare-backup "$STATE_DIRECTORY" \
  "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV" "$BACKUP_CONFIG" "$BACKUP_ROOT"
sh docker/release/release.sh backup "$STATE_DIRECTORY" \
  "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV" "$BACKUP_CONFIG" "$BACKUP_ROOT"
sh docker/release/release.sh continue "$STATE_DIRECTORY" \
  "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV" "$BACKUP_CONFIG" "$BACKUP_ROOT"
```

Выполнять следующую команду только после exit 0 и проверки ожидаемой фазы.
Backup включает prepare-backup, поэтому отдельная первая команда необязательна.
Уже committed candidate не останавливается повторным backup/prepare-backup.
Повтор continue проверяет health и завершает только недостающие receipts/cleanup.

Rollback — ветка обработки неудачи, **не шаг после успешного committed**:

```sh
sh docker/release/release.sh rollback "$STATE_DIRECTORY" \
  "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV" "$BACKUP_CONFIG" "$BACKUP_ROOT"
```

Успех: exit 0, соответствующий success event/receipt и подтверждённый текущий health.
Status после успешного релиза/rollback показывает idle; проверять также opaque ID
current. Исторический receipt сам по себе не подтверждает текущую работоспособность.
Девять сервисов должны быть healthy; дополнительно проверяются read-only DB/Redis/
RabbitMQ/S3 зависимости и JSON-каталог через Nginx. Worker health проверяет PID 1,
а не выполнение реальных jobs. Ingress запускается последним.

## Ошибка, SIGKILL и recovery_required

1. Зафиксировать exit code, status, IDs/images/exit/OOM/health контейнеров и журналы
   launch/recovery; сохранить исходный bundle/runtime и backup. Не публиковать secrets.
2. После SIGKILL перечитать state: rename мог завершиться до потери подтверждения.
   Повторять ту же команду с теми же аргументами; она проверяет receipts, backup и
   конфигурацию. Не удалять journal/intent, не менять revision/phase вручную.
3. Наличие recovery intent блокирует prepare-backup/backup/continue этого candidate,
   в том числе после успешного rollback. Для новой попытки нужен новый pipeline/manifest.
   Даже оборванная symlink intent/receipt означает неоднозначность и отказ.
4. Начиная с migrating считать схему потенциально изменённой, включая failed exit
   или отсутствие start receipt. Не запускать migrate повторно, migrate:rollback
   или старые writers. Незавершённый migration container автоматически не убивается:
   отдельно проверить, закончился ли процесс и какие изменения он применил.
5. В recovery_required повтор rollback продолжает только проверенную остановку
   writers и возвращает ошибку. Receipt recovery-required с причиной
   schema_may_have_changed означает подтверждённую остановку, а не восстановление.
   При изменённых/потерянных контейнерах или stop failure часть writers может
   работать: требуется их ручная изоляция после проверки принадлежности/состояния.
6. Оператор выбирает исправление схемы/совместимую версию либо явный snapshot
   recovery ниже. Не обходить recovery_required правкой state.json и не запускать
   прежние images на потенциально изменённой схеме.

Обычный restore-test PostgreSQL использует --no-owner --no-acl. Snapshot recovery
ниже дополнительно применяет globals, owners и ACL в новой изолированной cluster.
MinIO проверяется тем же локальным image ID
с запуском отдельного сервера и чтением сохранённых версий по S3 API. Это не проверка
переноса в другую MinIO-версию/topology. Поздний отказ запуска/rollback может оставить
часть готовых сервисов работающей; операция не транзакционна.

## Snapshot recovery после возможного изменения схемы

Это **явная операция с потерей изменений после backup**, а не автоматический
image rollback. Поддержан failed upgrade с незавершённой operation и существующим
current. Успешный committed deploy и первая установка без прежнего current не
переинтерпретируются как failed upgrade: команда откажет. Для них нужен отдельный
согласованный сценарий, а не подмена manifest или revision.

Предусловия:

- Подтверждённый backup именно этой operation; сохранены его COMPLETE, metadata,
  postgres.dump, globals.sql и minio.zip. Сделайте дополнительную защищённую копию
  на другом диске/узле **до** recovery; не перемещайте единственный backup.
- Все внешние writers/cron/SQL/S3 доступы исключены. Migration container должен
  завершиться; работающую или неоднозначную миграцию recover не убивает и не повторяет.
- RabbitMQ vhost / не содержит ready/unacknowledged сообщений: очереди не входят
  в backup. Preflight откажет при непустых очередях. Разберите/сохраните сообщения
  вне рабочего vhost отдельно; не используйте purge ради прохождения проверки.
  Отправленные письма и другие внешние эффекты восстановление отменить не может.
- Сохранены original candidate bundle/runtime/BACKUP_CONFIG и bundle/runtime
  прежнего current, соответствующие его deployment_config.git_sha. SOURCE_BUNDLE
  содержит три Compose-файла и публичный .env, SOURCE_RUNTIME — закрытые настройки.
  DB identity совпадает с исходной cluster; Redis/RabbitMQ конфигурация не меняется.
- Поддерживается local PostgreSQL 15 layout /var/lib/postgresql/data, один
  application login role и стандартные tablespaces. NOLOGIN роли/ACL восстанавливаются.
  Дополнительные LOGIN роли требуют отдельной процедуры восстановления их паролей:
  globals не содержит passwords, поэтому этот случай блокируется в staging.
- Все exact image IDs backup и прежнего current доступны локально, достаточно
  места для новых PG/MinIO томов и изолированного restore-test. Нет автоматического
  удаления старых/частичных томов, backup или journals.

Сначала проверить статус и backup (BACKUP_PATH берётся из сохранённого launch/recovery plan):

~~~sh
(
  set -eu
  sh docker/release/release.sh status "$STATE_DIRECTORY"
  sh docker/release/backup.sh verify "$STATE_DIRECTORY" "$BACKUP_CONFIG" "$BACKUP_PATH"
  sh docker/release/backup.sh restore-test "$STATE_DIRECTORY" "$BACKUP_CONFIG" "$BACKUP_PATH"
)
~~~

Команда recovery, включая безопасный повтор **с теми же аргументами**:

~~~sh
(
  set -eu
  umask 077
  sh docker/release/release.sh recover "$STATE_DIRECTORY" \
    "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV" "$BACKUP_CONFIG" "$BACKUP_ROOT" \
    "$SOURCE_BUNDLE" "$SOURCE_RUNTIME"
  sh docker/release/release.sh status "$STATE_DIRECTORY"
)
~~~

RELEASE_MANIFEST относится к неудачному candidate; current берётся только из
проверенного state. Команда держит ту же FD 9/flock, что и deploy/bootstrap/rollback.
При отсутствии recovery intent сначала выполняется прежний quiesce с фиксацией
recovery_required. После проверки сохранённых launch/backup/config receipts
останавливается исходный PostgreSQL. Исходные PG/MinIO volumes не перезаписываются.

В новых томах одноразовые tasks восстанавливают globals и SQL dump с
--exit-on-error, owners и ACL. Пароль application role задаётся из SOURCE_RUNTIME
без вывода в логи; временный recovery admin получает NOLOGIN. MinIO восстанавливается
существующим ZIP helper с проверкой файлов, затем проверяется запуск и чтение S3
версий существующим restore verifier. Redis/RabbitMQ не откатываются и не очищаются.

После подтверждения обоих томов тот же create/start/health протокол запускает
PostgreSQL/MinIO и **images прежнего current**; проверяет migrate:status (без migrate),
dependencies, workers и API, поднимая ingress последним. Только затем атомарно
снимается recovery_required и сохраняется state.data с именами восстановленных
томов. current/previous при failed upgrade остаются прежними. Failed migration
container удаляется после фиксации; данные и журналы не удаляются.

Признаки завершения: exit 0, event recovery_succeeded, phase idle и ожидаемый
current, receipt restore/launch-N/recovery-succeeded.json и текущий healthy/API.
Restore journal находится в $STATE_DIRECTORY/recovery-<failed-release-id>/restore.
Наличие одного старого receipt не заменяет повторную проверку health.

Следующие релизы обязательно выполняются тем же coordinator и state directory:
checkCompose применяет state.data ко всем будущим release-моделям. Новый
BACKUP_CONFIG берётся из restore/backup-settings.json, поскольку IDs PG/MinIO
изменились. Для повтора **этого** recover нужны original BACKUP_CONFIG и исходные
аргументы, а не новый settings. Не запускайте make up-prod/ручной compose up:
они не читают state.data и могут подключить повреждённые исходные тома.

Ошибки и повторы:

- SIGKILL наблюдателя: повтор recover ждёт тот же task/проверяет его exit и journal.
  После успешного импорта повторный импорт не производится, даже при readiness failure.
- Подтверждённый failed restore task не запускается снова. Он и частичные тома
  сохраняются; isolated stage PG останавливается и пишется abandoned receipt.
  После исправления причины можно явно выбрать **следующую** попытку:

~~~sh
sh docker/release/release.sh recover "$STATE_DIRECTORY" \
  "$RELEASE_MANIFEST" "$COMPOSE_BUNDLE" "$RUNTIME_ENV" "$BACKUP_CONFIG" "$BACKUP_ROOT" \
  "$SOURCE_BUNDLE" "$SOURCE_RUNTIME" 2
~~~

- Новая попытка разрешена только после terminal failure + abandoned предыдущей
  и до promotion. Она использует новые тома и тот же неизменённый проверенный backup.
  Если task ещё работает, его состояние неоднозначно или контейнер исчез, не
  удалять journals и не перескакивать attempt: остановиться для ручного разбора.
- Readiness failure оставляет operation pending и current неизменным. Исправьте
  внешнюю причину и повторите ту же попытку; уже восстановленные данные не затираются.
  Часть сервисов может работать; запрет внешних writers сохраняется до успеха.
  При изменившихся контейнерах/сети/config/backup команда откажет, не угадывая замену.
- После SIGKILL на границе atomic state commit повтор проверяет новые контейнеры,
  завершает cleanup/receipt и не переключается обратно на исходные тома.

Не удаляйте единственную копию backup или оригинальные/частичные тома для освобождения
места. При ENOSPC сначала добавьте место либо перенесите посторонние данные; backup
root и operation paths во время операции неизменны. Очистка разрешается отдельно
после проверки завершения, новой резервной копии восстановленного состояния и
согласованного retention. Автоматической destructive очистки в recover нет.

Адресные проверки:

~~~sh
node --test docker/release/recovery.test.mjs docker/release/deploy.test.mjs
BACKUP_DOCKER_TEST=1 BACKUP_TEST_PHP_IMAGE="$LOCAL_PHP_IMAGE_ID" \
  node --test docker/release/backup-docker.test.mjs
RESTORE_QUEUES_DOCKER_TEST=1 node --test docker/release/restore-queues-docker.test.mjs
~~~

Полная изолированная репетиция на уже имеющихся локально production digest images:

~~~sh
BOOTSTRAP_DOCKER_TEST=1 RECOVERY_APP_DOCKER_TEST=1 \
BOOTSTRAP_TEST_PHP_IMAGE="$PHP_IMAGE" BOOTSTRAP_TEST_NGINX_IMAGE="$NGINX_IMAGE" \
  node --test docker/release/bootstrap-docker.test.mjs
~~~

Она создаёт новый project/volumes, выполняет bootstrap и backup, имитирует failed
upgrade изменением SQL-схемы/строки и S3 object после миграций, затем проверяет
recover, прежние данные SQL/S3, отсутствие новой схемы, повтор команды и volume
mapping следующего релиза. Fixture manifests синтетические; тест проверяет
release-код на выбранных images, не происхождение images из текущего Git SHA.
Все Docker-проверки используют собственные ресурсы, без production env/VPS.

## Локальный gate и проверки на будущем сервере

Полный локальный release gate (нужны уже имеющиеся локальные tooling images):

```sh
BACKUP_DOCKER_TEST=1 RELEASE_RUNTIME_DOCKER_TEST=1 \
  node --test --test-concurrency=1 docker/release/*.test.mjs
```

Дополнительно: PHPStan, PHP-CS-Fixer/Rector dry-run, Composer validate, Compose config,
Laravel suites в изолированных сервисах, frontend npm test/build и production HTTP
checks. CI job release-checks запускает четырнадцать daemon-free test-файлов (bootstrap, state/manifest,
backup evidence, coordinator, continue, recovery intent/failures и fake MinIO), а также
JS/shell syntax. Published-manifest и `docker/minio/ci.test.mjs` проверяются frontend job; release PHP helpers
и scheduler проходят php -l в phpstan job. Node 24 Alpine job требует APK util-linux
и docker-cli-compose для flock/Compose config, но не Docker daemon/socket/DinD.
Временный каталог runner должен разрешать exec для тестовых fake adapters.
Реальные Docker restore/recovery/worker проверки и PHP protocol fixtures не входят
в этот gate; полный локальный набор по-прежнему необходим.
Fake lifecycle и Docker contract fixtures не доказывают полный реальный upgrade
Laravel с пользовательскими данными. Fresh image build отдельно требует доступных
base images/зависимостей; тест существующих image IDs не заменяет новую сборку.

После покупки VPS/домена отдельно проверить: ресурсы/архитектуру и диск/inodes,
Docker/Compose/flock/fsync на выбранном filesystem, SSH/доступы, firewall и отсутствие
публичных DB/Redis/RabbitMQ/MinIO портов, DNS, TLS/renewal и redirect, APP_URL/CORS,
Registry authentication и доступность digest-образов, secrets/permissions, clocks/timezone,
внешние health/логи/алерты, reboot/restart и длительность drain реальных jobs.
Нужны репетиция полного upgrade/recovery на репрезентативных данных, контроль
ролей/ACL и offsite encrypted backups, retention и измеренные RPO/RTO. Не выполнять
первый restore drill на единственной рабочей копии данных.
