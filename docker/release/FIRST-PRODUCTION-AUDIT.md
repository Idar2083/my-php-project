# Аудит первого production deploy — 2026-11-13

Проверен локальный HEAD `27a153c72ddb32a123360defa54a3a3e17f3b809`, ветка
`feature/task-12-frontend`. На начало аудита дерево чистое; HEAD совпадает
с локальной tracking ref origin. Remote не опрашивался и не изменялся.

## Подтверждено локально

- Три Compose-файла образуют release-модель: build и bind mounts убираются,
  frontend dev service удаляется, четыре PHP service используют один digest,
  Nginx использует второй. Infrastructure ports снимаются production override.
- `production-config` проверяет dev/prod Compose на публичных fixtures и Nginx
  config. Третий release override проверяется runtime/release тестами.
- `production-integration` архивирует чистый Git commit, проверяет production
  приложение и сохраняет images archive, IDs и SHA-256 (artifacts: 1 день).
- `publish-production` загружает именно этот archive, сверяет image IDs,
  проверяет отсутствие уже занятых image tags, публикует PHP/Nginx и сохраняет
  publication evidence (90 дней). Это не повторная сборка images.
- `release-manifest` использует IDs/RepoDigests публикации, фиксирует SHA,
  pipeline ID, deployment config SHA и два digest references; artifact 90 дней.
- `deploy-production` получает manifest и publication evidence, сверяет tag/SHA
  и публикацию. Bundle собирается в памяти из `git show SHA:path`, без env/secrets.
  Allowlist — 23 файла в `deploy-bundle.mjs`; все файлы и статические JS imports
  присутствуют. Сервер создаёт ещё пустой `.env`, `release.json`, `delivery.json`.
- `deploy-tools/` существует только на сервере по процедуре установки. Его пять
  исходников: `deploy-server.sh`, `deploy-server.mjs`, `deploy-bundle.mjs`,
  `manifest.mjs`, `published-manifest.mjs` в `docker/release/`.
- Deploy выполняется после stage barriers, сериализован resource group и flock.
  Без state job только доставляет bundle и завершается ошибкой: bootstrap ручной.
- MinIO/mc pipeline только получает и проверяет по уже опубликованным digest.
  Повторная публикация для первого deploy не требуется.

## Подтверждено на VPS

Результаты завершённой серверной проверки предоставлены пользователем;
повторные SSH-проверки и скачивания при обновлении документации не выполнялись.

- Все пять файлов в `/srv/pizza/deploy-tools/` побайтно совпадают с локальными:
  `deploy-server.sh`, `deploy-server.mjs`, `deploy-bundle.mjs`, `manifest.mjs`,
  `published-manifest.mjs`. Deployment-скрипты принадлежат deploy:deploy.
- `/srv/pizza`, `/srv/pizza/deploy-tools`, `/srv/pizza/shared`,
  `/srv/pizza/releases` — mode 0700, владелец deploy:deploy.
- `/srv/pizza/shared/runtime.env` существует: mode 0600, deploy:deploy.
  Проверка прав не подтверждает корректность runtime-конфигурации.
- Локально присутствуют `postgres:15-alpine`, `redis:7-alpine`,
  `rabbitmq:3.13-management-alpine`.
- Registry-доступ от имени deploy подтверждён для MinIO с digest
  `sha256:2a4a6bdc196960d85ececed03cdd37faea0f2cb90ebc6fdc01fb03586f3a16f6`
  и mc с digest
  `sha256:0da104852e8288d0a15b377dfdfffc721173cde3730f65fbc92df5bd115da992`.
  Это подтверждение доступа, а не утверждение о наличии обоих images локально.
  Повторно публиковать или скачивать MinIO/mc без необходимости не нужно.

Успешный branch pipeline с 185 тестами и готовые DNS/TLS подтверждены
пользователем. Первый production bootstrap ещё не выполнен.

## Оставшиеся проверки

- Права/владельцы shared/state и shared/backups, отсутствие symlinks в рабочих
  путях, Node.js 24+, Compose с `!reset`, flock, Docker-доступ deploy,
  свободное место и inodes не охвачены перечисленными результатами.
- SSH именно CI deploy identity и доступность будущих PHP/Nginx digest images
  требуют проверки; Registry-доступ к MinIO/mc уже подтверждён.
- Runtime-конфигурация ещё не проверена. Оператор должен подтвердить её полноту,
  согласование DB/POSTGRES и постоянство keys, HTTPS APP_URL и loopback upstream,
  две опубликованные MinIO/mc digest references. Секреты не выводить.
- Protected Environment `production` **не подтверждён**: раздел Protected
  Environments в интерфейсе проекта не обнаружен. Это не доказывает защиту
  окружения или недоступность функции на тарифе. До автоматической доставки
  нужно оценить политику доступа с опорой на protected tags/variables.

## Переменные GitLab

Контрольные локальные SHA-256; побайтовое совпадение файлов
`/srv/pizza/deploy-tools/` подтверждено завершённой проверкой:

```text
a64c67dc44043abcd9d6356a09e005fedd854b0014197a8a62bfc2dfb1c04c7b  deploy-server.sh
a831c2d1dbb1c1b0be8bd851dd3ad02e09708664d2c690002af132472f815f4f  deploy-server.mjs
903fe65a5e45a27dd070dd174812efe86a498e3fd9d9e7743cb471d94bc86d5a  deploy-bundle.mjs
e22863a88753ae27bc428444b5a4c4f58b7721b3a5b6bf516817504cd297e70d  manifest.mjs
7a1b33c89ea28294c13f85c6e09c8171038fdf7d1f58b0b82911ddb491adb02a  published-manifest.mjs
```

Protected Tag `v*` существует; Allowed to create — **Maintainers**.

Все шесть deployment-переменных присутствуют и имеют флаг Protected:
`DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_ROOT`, `DEPLOY_USER`, `SSH_KNOWN_HOSTS`,
`SSH_PRIVATE_KEY`. Последние две имеют тип **File**. Значения секретов
не читались и в отчёте не приводятся.

Scope всех восьми переменных на проверенном скриншоте — **All (default)**,
включая шесть deployment-переменных и `MINIO_CI_IMAGE`, `MINIO_MC_CI_IMAGE`.
Обе MinIO-переменные **не Protected** и доступны branch/MR/tag jobs.
Используются существующие полные project registry digest references;
для публикации application images — встроенные `CI_REGISTRY_*`.
Защита environment `production` этим набором переменных не подтверждается.

## Изменения и порядок разрешённого будущего запуска

Проверки: daemon-free release gate (14 файлов из CI плюс published-manifest
и MinIO CI tests) — **328/328 passed**, без пропусков, exit 0. Лог:
`/tmp/pizza-production-audit-gate-retry.log`. Использованы только временные
fixtures, fake adapters и Compose config; реальные Docker lifecycle тесты
не запускались. Начальные sandbox-прогоны давали сбои, отдельный bootstrap
вне sandbox прошёл 17/17; полный первый внешний прогон был прерван перезапуском
сервера инструментов. Итоговый полный повтор завершился успешно.

`node --check` для всех release mjs, `sh -n` для release/CI/entrypoint shell,
проверка полноты статических bundle imports и `git diff --check` прошли.
PHPUnit/PHPStan/CS-Fixer/Rector/frontend build не повторялись: код приложения
не менялся, успешный branch pipeline уже подтверждён пользователем.

Уточнён runbook и добавлен этот отчёт: объяснены расположение tools, bundle без отдельного
artifact, автоматическая доставка после version tag и ручной первый bootstrap,
а также переход от закрытого запуска к уже подготовленному HTTPS ingress.
Исходный runbook: `/tmp/pizza-first-production-audit/RUNBOOK.md.before`.
Deployment-код и CI не изменялись: однозначной ошибки в них аудит не установил.

1. Завершить оставшиеся проверки, включая runtime-конфигурацию, и оценить
   политику доступа при неподтверждённом Protected Environment. Уже подтверждённые
   проверки VPS и GitLab повторять без необходимости не нужно. Не пересоздавать runtime.
2. Просмотреть локальный diff. Commit/push этих изменений выполняются только
   по отдельному разрешению; текущий аудит этого не разрешает.
3. Отдельно разрешить создание и push version tag выбранного коммита:
   YAML автоматически запускает delivery job после успешных предыдущих stages.
4. Ожидать `FIRST_BOOTSTRAP_REQUIRED` на пустом state. Проверить доставленный
   bundle и разрешить bootstrap отдельно; команда есть в runbook. Выбрать
   постоянное новое Compose project name (например, `pizza-production`).
5. После успешного bootstrap проверить отсутствие целевого backup-settings перед
   его установкой, сохранить bootstrap settings в shared по runbook. При уже
   существующем файле остановиться для проверки и согласования замены.
6. Повторить только deploy-job того же pipeline; проверить внешние `/`, `/up`,
   API, workers и current. Не пересоздавать pipeline ради повтора deploy.

Публикация, commit, push, теги, deploy и изменения VPS в аудите не выполнялись.
Полная готовность первого production deployment пока не подтверждена:
не проверена runtime-конфигурация и не выполнен bootstrap. Метаданные переменных
и Protected Tag подтверждены; Protected Environment не подтверждён.
Последовательность первого запуска: tag → автоматическая доставка bundle →
`FIRST_BOOTSTRAP_REQUIRED` → ручной bootstrap → backup settings →
повтор deployment job того же pipeline. Все изменяющие действия требуют
отдельного разрешения; обновление документации их не разрешает.
