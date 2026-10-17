# Release runbook

Это инструкция для будущей согласованной операции. Команды изменения состояния
ниже не являются dry-run. Локальный аудит не разрешает production deploy.
Подробности форматов и ограничений: [README](../../README.md).

## Предусловия

- Linux, Node.js 24+, util-linux flock, Docker/Compose с поддержкой `!reset` и
  `!override`; доверенные PATH, Docker daemon и Compose bundle.
- Существующая установка зарегистрирована корректным `state.json`; project и
  current соответствуют реальным контейнерам и manifest. Готовой команды
  первичной регистрации/adoption нет. Не создавать пустое состояние для рабочей установки.
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
- Первый bootstrap пустой БД и внедрение существующей установки — отдельная
  процедура. `migrate --isolated` использует настроенный общий cache lock;
  при database cache таблица cache_locks должна уже существовать.

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
6. Оператор выбирает исправление схемы/совместимую версию либо восстановление
   проверенной копии **сначала в новой изолированной среде**. Согласовать потерю
   изменений после backup, владельцев/ACL/ролей и соответствие PostgreSQL↔MinIO.
   Автоматической команды восстановления рабочих томов или выхода из
   recovery_required нет. Не обходить это правкой state.json.

Restore-test PostgreSQL использует --no-owner --no-acl. Globals сохранены без
паролей ролей и автоматически не применяются: passwords, ownership, ACL и tablespaces
требуют отдельной процедуры и проверки. MinIO проверяется тем же локальным image ID
с запуском отдельного сервера и чтением сохранённых версий по S3 API. Это не проверка
переноса в другую MinIO-версию/topology. Поздний отказ запуска/rollback может оставить
часть готовых сервисов работающей; операция не транзакционна.

## Локальный gate и проверки на будущем сервере

Полный локальный release gate (нужны уже имеющиеся локальные tooling images):

```sh
BACKUP_DOCKER_TEST=1 RELEASE_RUNTIME_DOCKER_TEST=1 \
  node --test --test-concurrency=1 docker/release/*.test.mjs
```

Дополнительно: PHPStan, PHP-CS-Fixer/Rector dry-run, Composer validate, Compose config,
Laravel suites в изолированных сервисах, frontend npm test/build и production HTTP
checks. CI job release-checks запускает девять daemon-free test-файлов (state/manifest,
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
