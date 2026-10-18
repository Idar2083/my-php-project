# Release runbook

Это инструкция для будущей согласованной операции. Команды изменения состояния
ниже не являются dry-run. Локальный аудит не разрешает production deploy.
Подробности форматов и ограничений: [README](../../README.md).

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
(три Compose-файла и публичный `.env`) и runtime.env **вне bundle/Git**, mode 0600.
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
checks. CI job release-checks запускает одиннадцать daemon-free test-файлов (bootstrap, state/manifest,
backup evidence, coordinator, continue, recovery intent/failures и fake MinIO), а также
JS/shell syntax. Published-manifest уже проверяется frontend job; release PHP helpers
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
