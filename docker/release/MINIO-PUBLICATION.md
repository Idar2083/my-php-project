# MinIO/mc: итог подготовки публикации

Это план отдельной разрешаемой публикации. Ни одна команда публикации или deploy
в ходе подготовки не выполняется. VPS и приложение повторно не аудируются.

## Фиксированный предмет проверки

| Образ | Локальный OCI index ID | BuildKit record |
| --- | --- | --- |
| MinIO | `sha256:2a4a6bdc196960d85ececed03cdd37faea0f2cb90ebc6fdc01fb03586f3a16f6` | `m1aamt8p0fzvo4h3vmn9wlojd` |
| mc | `sha256:0da104852e8288d0a15b377dfdfffc721173cde3730f65fbc92df5bd115da992` | `1zfou1x7hkdbooajguz3gkt05` |

Предыдущая offline evidence остаётся неизменной:
`/home/tsimib/pizza-backend-artifacts/minio-publication-final-20261101/`.
Следующая версия инструмента, dossier и новая операция хранятся отдельно в
`/home/tsimib/pizza-backend-artifacts/minio-publication-ready-20261101/`.
Файл `READY_PREPARED_EVIDENCE.txt` в этом новом каталоге указывает новую операцию.
Приватные материалы, инструменты и исходные архивы не включать в Git/CI artifacts.

BuildKit output digests, исходные provenance blobs, встроенные Dockerfile,
архивные subjects, manifests/configs/layers/attestations проверяются существующим
инструментом. Текущие Dockerfile побайтно совпадают со встроенными. Все 260
module/version из Go buildinfo двух фактических бинарников проверены по h1
исходных zip: 241 у MinIO, 98 у mc, с пересечением версий. Причин пересобирать
образы нет. Независимая цифровая подпись не предусмотрена как обязательный gate
в этой процедуре/CI; это отдельное усиление защиты. Локальная проверка не выдаётся
за подпись издателя или доказательство побитовой воспроизводимости. Неполный
BuildKit resolvedDependencies для named contexts не заменяет проверки исходников.
Registry references появляются только после реального GET manifest и digest pull.

## Лицензии и исходники

| Компонент | Точная версия | Результат |
| --- | --- | --- |
| `github.com/mattn/go-localereader` | `v0.0.1` | Точный source zip сохранён ранее; README объявляет MIT. В обоих Linux-бинарниках отсутствует; код этого модуля не входит в распространяемый комплект linked sources. Отсутствие отдельного LICENSE здесь не блокирует эти образы. |
| `github.com/vbauerster/mpb/v8` | `v8.9.3` | В точном zip есть `UNLICENSE`; прежний сканер пропустил имя. Текст и исходники сохранены. |
| `github.com/minio/colorjson` | `v1.0.8` | Собственные source headers явно отсылают к Go BSD license; сохранены headers, полный BSD-3-Clause текст и source zip. |
| `github.com/minio/csvparser` | `v1.0.0` | То же; включён в MinIO, отсутствует в mc. |
| `github.com/minio/filepath` | `v1.0.0` | То же; включён в оба бинарника. |

Для обоих образов сохраняются исходные MinIO/mc AGPL-3.0-or-later LICENSE,
NOTICE и CREDITS. Файлы внутри образов сверены с upstream. Сопроводительный
комплект содержит исходники/уведомления всех linked Go module/version, Go
stdlib/compiler sources, Apache NOTICE/PATENTS, MIT/BSD/ISC/CC0/Unlicense тексты,
MPL source и исходные LGPL exceptions. В частности, для Paho сохранены собственные
`edl-v10`, `epl-v20` и NOTICE (разрешён permissive EDL/BSD вариант); для
`juju/ratelimit` сохранено точное LGPLv3 исключение для static linking.

MinIO содержит 26 runtime APK, mc — 17, из 18 уникальных origins, включая пакеты
Alpine base. Для каждого origin получен официальный aports snapshot именно по
`c` установленной APK database; version/revision сверены, все distfiles,
патчи и конфигурация проверены по SHA-512 точного APKBUILD. Они входят в комплект.
Обязательные условия охватывают GPL-2 source/scripts/config, LGPL source и право
замены динамических библиотек, MPL source, Apache license/notice и исходные
MIT/BSD/curl/Zlib уведомления. Точный список P/V/L/o/c есть в dossier; отдельная
лицензия слоя/имени Docker image не заменяет лицензий его содержимого.

Для встроенной Console сохранены её исходники, generated assets, source maps,
lockfiles и исходники/уведомления runtime npm closure (399 точных package/version,
консервативное надмножество непосредственно видимых в source maps). npm tarballs
проверены по опубликованному integrity и metadata точной версии. Для пропущенных
npm LICENSE сохранены точные upstream gitHead/release материалы либо стандартный
текст лицензии, явно объявленной в собственном README/package metadata, рядом с
исходным авторством. Такие дополнения помечены как supplied text, не как оригинал.
`inline-style-parser 0.1.1` сам ссылается на LICENSE `reworkcss/css v2.2.4` — сохранён
именно он. MDS `1.1.5` восстановлен из публичного fork по неизменному Git commit
`400914d72cb3ffa27d600e0ae1f17ece2182ec22` из Console yarn.lock, с `git fsck`;
подмены версии нет. Inter fonts совпали побайтно с MDS; SIL OFL сохранена.

Комплект `source-and-notices.tar.gz` содержит LICENSE/NOTICE/CREDITS, inventories,
исходники, инструкции сборки и внутренний SHA256SUMS.json. `distribution.json`
закрепляет SHA-256 комплекта, пару image IDs и постоянный URL доставки.
Это проверка точных материалов и объявленных лицензий для выбранных образов,
а не полное юридическое заключение обо всех способах использования.

## Единственное обязательное действие перед push образов

Исходники и notices должны быть доступны всем получателям образов без доплаты.
Локальный evidence, upstream URL и истекающие job artifacts этого не обеспечивают.
Выбран постоянный GitLab Generic Package в том же проекте: package
`minio-mc-source`, version = SHA-256 архива. Точный URL записан в `distribution.json`.
Запретить дубликаты/перезапись этой package version и исключить её из cleanup;
публиковать ссылку рядом с обеими image digest references. Доступ выдавать каждому
получателю образа: для deploy tokens дополнительно нужен `read_package_registry`.
Сохранять комплект, пока распространяются бинарники. При применимости AGPL §13
предоставлять ссылку на Corresponding Source сетевым пользователям; не удалять
существующие license/source links Console.

Публикация состоит из двух явных операций **после отдельного разрешения**:

1. `--publish-sources PREPARED_EVIDENCE`: интерактивный scoped deploy token с
   `read_package_registry`/`write_package_registry`; проверка отсутствия/точного
   существующего хеша, PUT и повторный GET/hash. До PUT сохраняется неизвестный
   результат; автоматический повтор после сбоя запрещён. Registry images не меняются.
2. `--publish PREPARED_EVIDENCE`: интерактивные credentials с
   `read_registry`/`write_registry` и `read_package_registry`. До первого push
   повторно проверяется скачивание именно source archive по его хешу. Сохраняются
   прежние TLS/Registry/auth/tag/digest/неопределённый-push gates. Секреты остаются
   в памяти; upload/download не передают их через argv или auth-файлы.

Для обоих режимов обязательны прежние `REGISTRY_PROJECT_CONFIRMED` и
`REGISTRY_EXCLUSIVE_PUBLICATION=yes`. Signed download redirect GitLab в
`storage.googleapis.com` получает отдельный запрос без Authorization; иные
redirects отклоняются. После неопределённого upload разрешена отдельная read-only
сверка: повторный PUT запрещён, а `--publish` всё равно требует успешного GET/hash.

## Порядок до первого production deploy

1. После разрешения доставить source package и опубликовать два образа режимами
   выше. Сохранить `ci-image-values.json`, реальные RepoDigests и source URL.
2. В GitLab задать `MINIO_CI_IMAGE`/`MINIO_MC_CI_IMAGE` полными полученными digest
   references: scope `*`, не protected-only, не masked. Registry должен быть включён,
   Docker runner linux/amd64 доступен branch/MR jobs; CI_JOB_TOKEN/Runner должен
   иметь read доступ к private images, без конфликтующего DOCKER_AUTH_CONFIG.
   Отдельная read-only проверка учётной записи публикации не доказывает доступ Runner:
   его подтверждает первый штатный pipeline. Доступ к private API/settings сейчас
   не подтверждён; не считать перечисленные настройки уже установленными.
3. После разрешения один итоговый commit/push согласованных файлов, успешный
   branch/MR pipeline со всеми quality/tests, MinIO contract и production integration.
   Не перезапускать старые audits VPS/приложения без новой ошибки или изменения.
4. До version-тега: protected `v*` только для ответственных; production environment
   с разрешёнными deployers (либо предусмотренная RUNBOOK политика, если тариф не
   поддерживает protection); шесть protected variables со scope `production`:
   `DEPLOY_HOST`, `DEPLOY_PORT`, `DEPLOY_USER`, `DEPLOY_ROOT`, File `SSH_PRIVATE_KEY`,
   File `SSH_KNOWN_HOSTS`. Проверенные ранее VPS keys/runtime не генерировать заново.
5. На VPS от deploy identity получить **только чтение** Registry; получить оба новых
   digest images. В существующем `shared/runtime.env` изменить только
   `MINIO_IMAGE=registry.gitlab.com/jihannaxz1/pizza-backend/minio-community@sha256:<published>`
   и `MINIO_MC_IMAGE=registry.gitlab.com/jihannaxz1/pizza-backend/mc-community@sha256:<published>`.
   Реальные значения брать из publication результата. APP_KEY/JWT_SECRET и другие
   секреты сохраняются. Убедиться в наличии требуемых PostgreSQL/Redis/RabbitMQ images,
   пяти доверенных deploy-tools и каталогов shared/state/backups с прежними правами;
   ранее подтверждённое состояние без причины заново не проверять.
6. После разрешения выпустить новый непереиспользованный `vMAJOR.MINOR.PATCH` на
   окончательный проверенный commit и отправить tag. Push protected tag запускает
   обычные quality → integration → publish-production → release-manifest →
   deploy-production; барьеры и `resource_group` не обходить. Проверить, что branch
   commit и source/tool changes готовы до tag, а новые файлы отслеживаются для git archive.
7. На первом пустом VPS deploy-job штатно доставит bundle и остановится при отсутствии
   `state.json`. Из **этого** bundle выполнить отдельный разрешённый ручной bootstrap
   по RUNBOOK с его manifest, tag/pipeline ID и постоянным Compose project.
   Bootstrap использует production PHP image как backup utility, выполняет baseline
   backup/restore-test, миграции, readiness и регистрирует current.
8. После успешного bootstrap установить `bootstrap/backup-settings.json` в
   `shared/backup-settings.json` (0600), повторить **только deploy-job того же pipeline**.
   Он проверит current/readiness без повторных миграций. Успех job и current с тем же
   manifest завершают первый deploy. Проверить доступ через предусмотренный туннель
   либо уже подготовленный ingress; публичный HTTPS открывать только с готовыми DNS/TLS.

Основания: [GNU AGPLv3](https://www.gnu.org/licenses/agpl-3.0.html),
[GNU GPLv2](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html),
[GNU FAQ о source distribution](https://www.gnu.org/licenses/gpl-faq.en.html#SourceAndBinaryOnDifferentSites),
[GitLab Generic Packages](https://docs.gitlab.com/user/packages/generic_packages/),
[Registry auth](https://docs.gitlab.com/user/packages/container_registry/authenticate_with_container_registry/),
[protected tags](https://docs.gitlab.com/user/project/protected_tags/),
[protected environments](https://docs.gitlab.com/ci/environments/protected_environments/).
