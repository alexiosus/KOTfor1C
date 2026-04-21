# Development (документация по коду)

Документ для разработчиков расширения KOT for 1C.

## 1) Архитектура на уровне модулей

| Файл | Роль |
|---|---|
| `src/extension.ts` | Точка входа: регистрация providers/команд, конвейер сохранения, интеграция между подсистемами |
| `src/phaseSwitcher.ts` | Backend Test Manager: webview-мост, кеш сценариев, сборка, запуск Vanessa, статусы запуска |
| `src/workspaceScanner.ts` | Полный скан текущего корня сценариев, построение `TestInfo` |
| `src/completionProvider.ts` | IntelliSense шагов и вызовов вложенных сценариев |
| `src/hoverProvider.ts` | Hover по шагам и вызовам |
| `src/scenarioSyntaxHighlightProvider.ts` | Semantic tokens для Gherkin-подсветки внутри `ТекстСценария` YAML-сценариев |
| `src/scenarioHeaderInlayHintsProvider.ts` | Inlay-иконки (карандаш) у полей `ДанныеСценария.Имя` / `ДанныеСценария.Код` для быстрых команд переименования/смены кода |
| `src/scenarioDiagnostics.ts` | Диагностика и code actions |
| `src/commandHandlers.ts` | Редактирование/навигация/авто-операции по YAML |
| `src/scenarioCreator.ts` | Создание главных и вложенных сценариев по шаблонам |
| `src/phaseSwitcherMetadata.ts` | Работа с `KOTМетаданные`, миграция legacy-тегов |
| `src/kotMetadataDescription.ts` | Парсинг, нормализация и upsert блока `KOTМетаданные.Описание` в YAML |
| `src/scenarioAiDescription.ts` | Генерация AI-описания сценария для `KOTМетаданные.Описание` |
| `src/aiClient.ts` | Унифицированный AI-клиент для `chatCompletions` / `responses`, валидация настроек и HTTP transport |
| `src/configurationDiffAiReport.ts` | Сбор diff конфигурации, эвристики влияния и генерация AI-отчета для тестировщика |
| `src/testReviewAiReport.ts` | AI-ревью измененных тестов на основе diff тестов, diff конфигурации и опционального `UserStory` |
| `src/yamlParametersManager.ts` | Webview менеджера параметров (СППР/VA/GlobalVars) |
| `src/infobaseManager.ts` | Backend каталога ИБ: сбор общего списка баз, операции подготовки, launch keys и platform override |
| `src/infobaseManagerPanel.ts` | Webview `KOT Infobase Manager` |
| `src/formExplorerPanel.ts` | Webview-панель исследования открытой формы 1С через JSON snapshot |
| `src/formExplorerPaths.ts` | Разрешение настроек путей Form Explorer: snapshot, исходники конфигурации, каталог генерации |
| `src/formExplorerExtensionGenerator.ts` | Legacy-генератор расширения Form Explorer и связанные build-пути `.cfe` (оставлен для совместимости/внутренних сценариев) |
| `src/formExplorerBuilder.ts` | Подготовка sidecar-файлов Form Explorer и служебных runtime-артефактов |
| `src/formExplorerBridgeGenerator.ts` | Bridge-based запуск Form Explorer: подготовка startup-ИБ, config JSON и старт связки `TestManager` + `TestClient` |
| `src/formExplorerLiveSnapshot.ts` | Разрешение актуального live snapshot-а Form Explorer и его кэширование для editor-side интеграций |
| `src/startupInfobase.ts` | Легковесная startup-ИБ для Vanessa и `СборкаТекстовСценариев`: автосоздание, output и фоновый прогрев |
| `src/oneCPlatform.ts` | Автоопределение установленной платформы 1С и разрешение путей `1cv8c.exe` / `1cv8.exe` |
| `src/formExplorerEnrichment.ts` | Обогащение runtime snapshot-а данными из `Form.xml` и metadata выгрузки конфигурации |
| `src/formExplorerTypes.ts` | Контракт и нормализация snapshot JSON для Form Explorer |
| `src/stepsFetcher.ts` | Загрузка и кеширование `steps.htm` |
| `src/scenarioParameterUtils.ts` | Нормализация и дефолты параметров |
| `media/phaseSwitcher.*` | UI Test Manager |
| `media/yamlParameters.*` | UI менеджера параметров |
| `media/formExplorer.*` | UI панели Form Explorer |
| `res/formExplorer/bridge/KOTFormExplorerBridge.bsl` | Клиентский модуль EPF-моста, который опрашивает `TestClient`, собирает snapshot и читает request-файлы |
| `tools/form-explorer/build-cfe.*` | Legacy-скрипты для старой `.cfe`-сборки Form Explorer |

## 2) Основной runtime-поток

1. Extension активируется (`onStartupFinished`).
2. Инициализируется кеш сценариев на основе текущего корня сценариев.
3. Подключаются completion/hover/diagnostics.
4. Регистрируются команды `kotTestToolkit.*`.
5. На события редактора (`open/change/save/close`) срабатывают локальные обработчики.

## 3) Конвейер сохранения (ключевая логика)

На сохранение сценария может выполняться цепочка:

1. Валидация, что файл — сценарий.
2. Миграция/восстановление `KOTМетаданные` (если требуется).
3. Анализ изменений (вызовы, параметры, имя).
4. Условные авто-операции:
   - tabs -> spaces;
   - выравнивание таблиц;
   - выравнивание параметров вызова;
   - перезаполнение `ВложенныеСценарии`;
   - перезаполнение `ПараметрыСценария`.
5. Обновление кеша и статусов связанных сценариев.

Важно: перезаполнение секций запускается только при релевантных изменениях или неполной структуре.

Дополнительно:

- тяжелая post-save обработка выполняется для активного сценария;
- сохранения неактивных сценариев ставятся в очередь `pendingBackgroundScenarioFiles` и обрабатываются командой batch-repair (например, при использовании глобальной замены поиском);
- для batch-repair файл считается `updated` только при фактическом изменении итогового текста;
- в batch-repair есть защита критичных секций с rollback.

## 4) Диагностика

Режимы:

- локальный (активный файл);
- связанные родительские сценарии (по графу вызовов вверх);
- глобальное сканирование (по команде).

Особенности:

- `Maybe you meant` рассчитывается для локального сценария;
- глобальный проход сделан как тяжелая ручная операция;
- дубликаты `ДанныеСценария.Код` проверяются через кеш сценариев.

## 5) Test Manager: backend + frontend

### Backend (`src/phaseSwitcher.ts`)

- Хранит `_testCache`.
- Собирает/отдает состояние групп, тестов, избранного, статусов запуска.
- Управляет сборкой и запуском Vanessa.
- Ведет run-state (`running/passed/failed/stale`) и runtime-логи.
- Ведет состояние `scenarioRepairInProgress/scenarioRepairCancelling` для webview.

### Frontend (`media/phaseSwitcher.js`)

- Рендер групп/сценариев.
- Отправка команд backend через `postMessage`.
- Контекстные действия по сценарию/группе.
- Вкладка `Избранное`, drag-and-drop в редактор.
- Меню `More actions`.

## 6) Сборка и запуск Vanessa

### Сборка

- Сборка выполняется через EPF `СборкаТекстовСценариев`.
- Параметры берутся из менеджера параметров.
- Формируются `.feature` и `.json` артефакты.
- Ошибки сборки читаются из output-артефактов (`BuildErrors`/JUnit).

### Запуск

- Built-in launcher: расширение само формирует команду запуска 1С + Vanessa.
- Template launcher: используется `runVanessa.commandTemplate`.
- Runtime-файлы (`лог/статус`) пишутся в `runVanessa.runtimeDirectory`.
- Live-log читается периодически по таймеру.

### Bundled startup template

Для built-in запуска Vanessa и `СборкаТекстовСценариев` Windows-версия расширения должна включать в bundle файл:

- `tools/startup-infobase/KOTStartupTemplate.dt`

Это не пользовательский артефакт проекта, а release-артефакт самого расширения. Template должен быть подготовлен один раз разработчиком расширения и входить в `vsix`.

Требования к template-базе:

- это отдельная техническая база, не рабочая проектная ИБ;
- база не должна быть полностью пустой: нужна минимальная конфигурация хотя бы с одной административной ролью;
- в базе должен существовать пользователь `KOTStartupService` без пароля;
- пользователю должна быть назначена административная роль;
- у пользователя должна быть включена стандартная аутентификация;
- у пользователя должна быть выключена `Аутентификация ОС`;
- у пользователя должна быть выключена `Защита от опасных действий`;
- в конфигурации и у пользователя должен быть доступен язык `Русский`, иначе `СборкаТекстовСценариев.epf` может падать на `НСтр(...)`.

## 7) Менеджер параметров (webview)

Функциональные части:

- СППР-параметры (для `yaml_parameters.json`);
- дополнительные VA-параметры (runtime-переопределение);
- `GlobalVars`.

Хранение:

- используется SecretStorage для состояния менеджера.

## 8) Form Explorer: bridge + static enrichment

Поток Form Explorer:

1. `src/formExplorerBridgeGenerator.ts` готовит shared startup-ИБ, пишет `bridge-config.json` и стартует две 1С-сессии:
   - целевую базу в `TestClient`;
   - служебную startup-ИБ в `TestManager` с `KOTFormExplorerBridge.epf`.
2. `res/formExplorer/bridge/KOTFormExplorerBridge.bsl` каждую секунду опрашивает `TestClient`, собирает snapshot активной формы и реагирует на request-файл (`auto` / `manual` / `refresh` / `table` / `locator`).
3. Bridge пишет:
   - `form-snapshot.json`
   - `adapter-mode.txt`
   - `adapter-mode-request.txt`
   - `bridge/bridge-config.json`
   - `bridge/bridge-status.txt`
4. `src/formExplorerPanel.ts` читает snapshot и mode-state, а `src/formExplorerEnrichment.ts` обогащает данные из `Form.xml`.
5. `src/formExplorerLiveSnapshot.ts` переиспользует тот же snapshot/enrichment слой для completion/hover вне webview.
6. `media/formExplorer.*` показывает UI-инспектор и управляет bridge-режимом `manual/auto`.

Особенности:

- bridge не внедряется в тестируемую базу и не требует установки runtime-расширения;
- отдельный poller в панели отслеживает PID и при закрытии одной стороны завершает вторую;
- `auto snapshot` в EPF-мосте оптимизирован: файл переписывается только если содержимое snapshot реально изменилось.

## 9) Где расширять функционал

### Добавить новую команду

1. Добавить `contributes.commands` в `package.json`.
2. Добавить пункт меню/палитры (если нужно).
3. Зарегистрировать handler в `src/extension.ts`.
4. Реализовать логику в `src/commandHandlers.ts` или отдельном модуле.
5. Добавить l10n-строки (`package.nls*`, `l10n/bundle*`).

Пример новых batch-команд:

- `kotTestToolkit.processQueuedScenarioFiles`
- `kotTestToolkit.processAllScenarioFiles`
- `kotTestToolkit.cancelScenarioRepair`

### Добавить новую диагностику

1. Реализовать правило в `src/scenarioDiagnostics.ts`.
2. Добавить код/сообщение/severity.
3. Добавить quick fix при необходимости.
4. Добавить переводные строки.

### Добавить пункт в Test Manager

1. Добавить UI-элемент в `media/phaseSwitcher.html/js`.
2. Проложить `postMessage` в backend.
3. Обработать сообщение в `src/phaseSwitcher.ts`.
4. Обновить модели состояния и l10n.

## 10) Что проверять после изменений

Минимум:

1. `npm run compile`
2. Проверить в VS Code:
   - completion/hover;
   - diagnostics + quick fix;
   - конвейер сохранения;
   - Test Manager (чекбоксы -> build filter, build/run/statuses);
   - менеджер параметров (все вкладки, импорт/экспорт);
   - Form Explorer webview.

3. Если менялся bridge Form Explorer:
   - пересобрать `KOTFormExplorerBridge.epf`, если правился BSL source;
   - перезапустить `TestClient` и окно моста;
   - проверить manual/auto режим, locator и snapshot-refresh.

## 11) Что важно не ломать

- Инкрементальность кеша: избегать полных пересканирований без необходимости.
- Производительность diagnostics на больших проектах.
- Корректность stale-статусов после изменения сценариев.
- Совместимость с обоими языками UI (RU/EN).
- Стабильность webview-состояний при скрытии/повторном открытии панели.
