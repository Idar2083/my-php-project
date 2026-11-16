# Безопасный состав будущего коммита этапа 12

В текущем запуске git add/commit/push не выполнялись. Этот документ — план,
не выполненные команды. Не использовать git add . / git add -A.

## Область этапа

Полный список — [stage12-files.txt](stage12-files.txt): 34 пути (7 отслеживаемых
изменённых файлов и 27 новых файлов относительно HEAD). Он включает покупательский
Vue UI, административный Order API, совместимую пагинацию покупателя, тесты и
документацию. Это список для аудита, **не** pathspec для автоматического git add:
два файла содержат изменения других этапов.

[stage12-whole-files.txt](stage12-whole-files.txt) содержит 32 пути, который можно
рассматривать целиком после просмотра diff. Из него исключены оба смешанных файла.
Каталоги целиком не перечисляются: каждый путь указан явно. Перед использованием
список нужно сверить с текущим рабочим деревом — после этого запуска могли появиться
новые чужие изменения даже внутри перечисленных файлов.

## Смешанные файлы — только ручное разделение

1. `app/routes/api.php`: этапу 12 принадлежат импорт AdminOrderController и два
   GET-маршрута `/admin/orders` и `/admin/orders/{orderId}` внутри admin-группы.
   Route::pattern для идентификаторов и throttle login/register относятся к этапу
   безопасности. Они сохранены, но не должны случайно попасть в UI-коммит.
2. `app/app/Modules/Order/Application/Services/OrderService.php`: этапу 12 принадлежат
   импорт LengthAwarePaginator, getAdminOrders/getAdminOrder и опциональная
   пагинация getOrders с дополнительным orderByDesc(id) для устойчивого порядка.
   Проверка предельной суммы 99999999.99 внутри create — предыдущий этап безопасности.

Никакого автоматического разделения hunks или записи в index не делалось.
Обычный git add этих двух файлов включит чужие изменения; полный manifest
поэтому нельзя подавать git add --pathspec-from-file.

## Зависимости и неизвестное происхождение

Текущие тесты проверяют суммарное рабочее дерево. В частности, проверки 404 для
некорректных ID зависят от middleware/маршрутных ограничений предыдущего этапа;
правила цен, суммы заказа и ролей также уже исправлены раньше. Успешный полный
прогон не доказывает, что изолированный UI-коммит поверх старого HEAD самодостаточен.
Сначала владельцы предыдущих изменений должны согласовать/подготовить отдельные
коммиты-зависимости. Альтернатива — явно согласованный совместный коммит; молча
включать эти зависимости как собственную работу этапа 12 нельзя.

На начало запуска обнаружено ровно состояние прошлого отчёта: 45 modified / 48
untracked-записей. Список путей и статусов соответствует
прошлому отчёту. Полных контрольных сумм прежнего запуска для всех файлов нет;
контрольные суммы всех файлов сняты перед изменениями текущего запуска. Назначение прежних
файлов известно по путям и отчётам; независимого Git-подтверждения авторства
незакоммиченных hunks нет. Поэтому они исключены из stage12 manifest, а не
автоматически приписаны автору этого запуска. Если владелец не подтвердит их
происхождение, считать их чужими/неатрибутированными и не включать.

## Точный следующий шаг — в отдельном запуске с разрешением на staging

1. Сохранить актуальный diff/статус и проверить ветку feature/task-12-frontend.
   Согласовать коммиты предыдущих этапов/зависимостей; не применять reset/clean.
2. Просмотреть все 32 whole-file кандидаты и оба смешанных diff. При изменениях
   после аудита пересмотреть список; не использовать прежнюю атрибуцию вслепую.
3. Только после разрешения на staging можно выполнить:

   ```bash
   git add --pathspec-from-file=app/docs/frontend/stage12-whole-files.txt
   git add -p -- app/routes/api.php app/app/Modules/Order/Application/Services/OrderService.php
   git diff --cached --name-status
   git diff --cached --stat
   git diff --cached --check
   git diff --cached
   ```

   В интерактивном выборе включить только описанные выше hunks этапа 12; если
   git объединяет их с защитой предыдущего этапа, вручную разделить/отредактировать
   hunk и проверить итог. Не соглашаться на целый файл из-за неудобства разделения.
4. Проверить staged-кандидат в отдельной временной копии с одобренными
   коммитами-зависимостями и изолированной БД. Нельзя судить о staged-состоянии по
   тестам рабочего дерева, где присутствуют unstaged-зависимости.
5. Только после просмотра staged diff и тестов отдельно разрешить commit.
   Пример заголовка: `feat: add buyer checkout and admin order management`.
   Push — также отдельное действие, не часть текущего разрешения.

Приведённые команды сейчас **не запускались**. Index пуст; HEAD неизменён.

## Секреты и артефакты

Manifest не содержит .env, runtime/local config, логов, node_modules, vendor,
dist, архивов или образов. Новых зависимостей нет. app/.env, .env.local, dist,
node_modules и рабочие логи игнорируются Git. Уже tracked `.env` содержит публичные
настройки без заполненных literal secret-полей; tracked app/.env.testing содержит
тестовые ключи, в том числе S3 secret, совпадающий с локальным MinIO root password.
Он не добавлен и не изменён этим этапом; значения не выводились. До публичного
запуска нужно исключить повторное использование опубликованного тестового секрета
и выполнить отдельную настройку ограниченных сервисных ключей/ротацию там, где
этот секрет реально используется. Изменения инфраструктуры здесь запрещены.
Статический поиск private keys/AWS access key patterns/GitLab PAT не нашёл новых
секретов; это не заменяет проверку владельцем всех конфигураций и истории Git.

## Предыдущие изменения — исключить из этапа 12

Ниже перечислен остаток рабочего дерева, а не файлы для git add. Они сохранены
байт в байт в текущем запуске. Два смешанных файла описаны отдельно выше.

Отслеживаемые изменения предыдущих этапов (39):

```text
.gitignore
.gitlab-ci.yml
README.md
app/app/Modules/Auth/Domain/Models/User.php
app/app/Modules/Auth/Presentation/Requests/LoginRequest.php
app/app/Modules/Auth/Presentation/Requests/RegisterRequest.php
app/app/Modules/Cart/Application/Services/CartService.php
app/app/Modules/Cart/Presentation/Requests/StoreCartItemRequest.php
app/app/Modules/Cart/Presentation/Requests/UpdateCartItemRequest.php
app/app/Modules/Catalog/Application/Services/ProductService.php
app/app/Modules/Catalog/Domain/Models/Product.php
app/app/Modules/Catalog/Presentation/Controllers/ProductController.php
app/app/Modules/Catalog/Presentation/Requests/StoreProductRequest.php
app/app/Modules/Catalog/Presentation/Requests/UpdateProductRequest.php
app/app/Modules/Order/Presentation/Requests/StoreOrderRequest.php
app/app/Modules/Report/Application/Handlers/CreateReportHandler.php
app/app/Modules/Report/Application/Handlers/GenerateReportHandler.php
app/app/Modules/Report/Application/Jobs/GenerateReportJob.php
app/app/Modules/Report/Application/Services/JsonlReportWriter.php
app/app/Modules/Report/Application/Services/ReportGenerationService.php
app/app/Modules/Report/Presentation/Controllers/ReportController.php
app/app/Providers/AppServiceProvider.php
app/app/Shared/Application/Outbox/OutboxProcessor.php
app/app/Shared/Infrastructure/Outbox/Repositories/DatabaseOutboxEventRepository.php
app/bootstrap/app.php
app/tests/Feature/Cart/CartConcurrencyTest.php
app/tests/Feature/Catalog/ProductCacheTest.php
app/tests/Feature/Order/CreateOrderTest.php
app/tests/Feature/Report/CreateReportTest.php
app/tests/Feature/Report/DownloadReportTest.php
app/tests/Support/concurrency_cart_worker.php
app/tests/Unit/Report/ReportGenerationServiceFailureTest.php
docker-compose.prod.yml
docker/release/backup-docker.mjs
docker/release/backup-docker.test.mjs
docker/release/backup.mjs
docker/release/release.sh
docker/release/release.test.mjs
docker/release/state.mjs
```

Прежние неотслеживаемые файлы (41; git status агрегирует каталоги):

```text
app/app/Http/Middleware/ValidateRouteIdentifiers.php
app/app/Modules/Auth/Infrastructure/Console/CreateAdmin.php
app/app/Modules/Catalog/Domain/Enums/ProductCategory.php
app/app/Modules/Catalog/Presentation/Rules/SupportedProductCategory.php
app/app/Modules/Report/Application/Exceptions/PermanentReportGenerationException.php
app/app/Modules/Report/Application/Exceptions/RetryableReportPublicationException.php
app/app/Modules/Report/Domain/Events/ReportRequestedEvent.php
app/app/Modules/Report/Infrastructure/Messaging/PublishReportJob.php
app/docs/business-rules-stage1.md
app/docs/security/API-SECURITY.md
app/docs/security/VERIFICATION.md
app/docs/security/minio-app-policy.json
app/tests/Feature/Auth/ApiSecurityTest.php
app/tests/Feature/Auth/CreateAdminCommandTest.php
app/tests/Feature/Catalog/ProductBusinessRulesTest.php
app/tests/Integration/Report/ReportReliabilityTest.php
app/tests/Support/minio_policy_check.php
app/tests/Support/report_queue_worker.php
docker/ci/check-release-tags.sh
docker/release/RUNBOOK.md
docker/release/coordinator-backup.test.mjs
docker/release/coordinator-docker.mjs
docker/release/coordinator-test-support.mjs
docker/release/coordinator.mjs
docker/release/coordinator.test.mjs
docker/release/minio-service-check.php
docker/release/minio-service.test.mjs
docker/release/published-manifest.mjs
docker/release/published-manifest.test.mjs
docker/release/recovery-docker.test.mjs
docker/release/recovery-runtime.mjs
docker/release/recovery.mjs
docker/release/recovery.test.mjs
docker/release/release-readiness.php
docker/release/release-readiness.test.mjs
docker/release/release-run.mjs
docker/release/release-run.test.mjs
docker/release/release-runtime-docker.test.mjs
docker/release/release-runtime.mjs
docker/release/release-tags.test.mjs
docker/release/release-test-support.mjs
```
