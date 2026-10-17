# Результаты этапа безопасности API

Проверки: локальные Docker-контейнеры, PHP 8.4.23, PostgreSQL 15,
RabbitMQ 3.13, Redis 7, MinIO. Отдельная сеть pizza-security-isolated;
новые контейнеры без development-томов и без публикации портов.
PHPUnit использовал pizza_app_test на postgres в этой отдельной сети.
Настройки development-БД и её данные не менялись, подключения к ней не было.

## Запуски PHPUnit

| Запуск | Результат |
|---|---|
| ApiSecurityTest, первый | 7 тестов, 118 проверок, 1 ошибка ожидания в новом тесте: отсутствующий отчёт возвращает 404 при model binding до admin middleware. Тест исправлен созданием существующего отчёта, проверка 403 сохранена. |
| Полный набор, первый | OK: 165 тестов, 1031 проверка |
| Auth + CreateOrderTest + DownloadReportTest | OK: 65 тестов, 429 проверок |
| Полный набор после дополнений | OK: 173 теста, 1082 проверки |
| Итоговый полный набор | OK: 174 теста, 1082 проверки |

Регрессии проверяют 429 и Retry-After, истечение лимита, смену email,
подмену X-Forwarded-For, повторный вход с рабочими JWT, невозможность назначения
роли регистрацией/fill(), запрет всех административных действий покупателю,
интерактивное создание администратора и отказы при несовпадении паролей,
дубликате email и --no-interaction. Проверяются вес, пагинация, ID, количество,
delivery_method, переполнение суммы заказа, игнорирование подмены владельца,
цены и статуса, безопасные ошибки отчётов, включая скачивание при debug=true.
Существующие тесты проверок владельца заказа/корзины и смены ролей сохранены.

## Остальные проверки

* PHPStan `analyse app routes config database --no-progress`: три запуска, все OK.
* PHP-CS-Fixer `fix --dry-run --diff`: первый запуск нашёл 2 файла
  (числовые литералы теста и лишняя пустая строка), второй — OK; после
  упорядочения импортов следующий запуск нашёл 1 файл, итоговый — OK,
  0 из 160 файлов требуют изменений. Форматирование исправлялось точечно.
  Инструмент предупреждает о запуске на PHP 8.4 при минимальном PHP 8.3
  в composer.json; ошибками итоговая проверка не завершилась.
* Rector `process --dry-run`: первый запуск предложил упрощение regex;
  вместо длинного regex введена читаемая проверка диапазона ID в middleware.
  Два последующих запуска — OK, изменений не предлагают.
* Composer `validate --strict`: OK, composer.json is valid.
* `git diff --check`: все запуски OK. Git предупреждает о существующих
  настройках LF/CRLF в некоторых файлах предыдущего этапа; whitespace-ошибок нет.
* MinIO: политика назначена только временному пользователю временного MinIO.
  Первый smoke test Laravel Storage — OK: put/head/read, запреты write вне
  префикса и delete. Сохранённый tests/Support/minio_policy_check.php — OK,
  дополнительно запрещены ListBuckets и ListObjectsV2 вне префикса.
  Реальные политики/учётные записи MinIO проекта не менялись.

Все запрошенные тесты и статические проверки выполнены. Production-проверок,
нагрузочного тестирования лимитера, multipart upload больших файлов и проверки
реальной цепочки reverse proxy не было. Применение ограниченных ключей MinIO
и настройка proxy требуют отдельного этапа развёртывания.

## Изменённые файлы именно этого этапа

Пути относительно корня репозитория:

```text
app/app/Modules/Auth/Domain/Models/User.php
app/app/Modules/Auth/Presentation/Requests/LoginRequest.php
app/app/Modules/Auth/Presentation/Requests/RegisterRequest.php
app/app/Modules/Cart/Presentation/Requests/StoreCartItemRequest.php
app/app/Modules/Cart/Presentation/Requests/UpdateCartItemRequest.php
app/app/Modules/Catalog/Presentation/Controllers/ProductController.php
app/app/Modules/Catalog/Presentation/Requests/StoreProductRequest.php
app/app/Modules/Catalog/Presentation/Requests/UpdateProductRequest.php
app/app/Modules/Order/Application/Services/OrderService.php
app/app/Modules/Order/Presentation/Requests/StoreOrderRequest.php
app/app/Modules/Report/Application/Services/ReportGenerationService.php
app/app/Modules/Report/Presentation/Controllers/ReportController.php
app/app/Providers/AppServiceProvider.php
app/bootstrap/app.php
app/routes/api.php
app/tests/Feature/Order/CreateOrderTest.php
app/tests/Feature/Report/DownloadReportTest.php
app/tests/Unit/Report/ReportGenerationServiceFailureTest.php
```

Созданы:

```text
app/app/Http/Middleware/ValidateRouteIdentifiers.php
app/app/Modules/Auth/Infrastructure/Console/CreateAdmin.php
app/tests/Feature/Auth/ApiSecurityTest.php
app/tests/Feature/Auth/CreateAdminCommandTest.php
app/tests/Support/minio_policy_check.php
app/docs/security/API-SECURITY.md
app/docs/security/minio-app-policy.json
app/docs/security/VERIFICATION.md
```

## Git

До работы: feature/task-12-frontend, 28 изменённых отслеживаемых файлов,
также неотслеживаемые файлы предыдущего этапа, index пуст.
После: та же ветка, 41 изменённый отслеживаемый файл, index пуст;
18 отслеживаемых файлов затронуты этим этапом (5 уже содержали изменения),
созданы 8 файлов. Существующие изменения Catalog, Cart, Report, outbox,
release/backup/recovery сохранены. Compose, CI, frontend, production/release
инфраструктура этим этапом не редактировались. Коммитов и push не было;
reset/clean/массовое восстановление не применялись.
