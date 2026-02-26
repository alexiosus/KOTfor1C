# Development (документация по коду)

Документ для разработчиков расширения KOT for 1C.

## 1) Архитектура на уровне модулей

| Файл | Роль |
|---|---|
| `src/extension.ts` | Точка входа: регистрация providers/команд, save-pipeline, интеграция между подсистемами |
| `src/phaseSwitcher.ts` | Backend Test Manager (`Менеджер тестов`): webview-мост, кеш сценариев, сборка, запуск Vanessa, статусы запуска |
| `src/workspaceScanner.ts` | Полный скан `yamlSourceDirectory`, построение `TestInfo` |
| `src/completionProvider.ts` | IntelliSense шагов и вызовов вложенных сценариев |
| `src/hoverProvider.ts` | Hover по шагам и вызовам |
| `src/scenarioHeaderInlayHintsProvider.ts` | Inlay-иконки (карандаш) у полей `ДанныеСценария.Имя` / `ДанныеСценария.Код` для быстрых команд переименования/смены кода |
| `src/scenarioDiagnostics.ts` | Диагностика и code actions |
| `src/commandHandlers.ts` | Редактирование/навигация/авто-операции по YAML |
| `src/scenarioCreator.ts` | Создание главных и вложенных сценариев по шаблонам |
| `src/phaseSwitcherMetadata.ts` | Работа с `KOTМетаданные`, миграция legacy-тегов |
| `src/yamlParametersManager.ts` | Webview менеджера параметров (СППР/VA/GlobalVars) |
| `src/stepsFetcher.ts` | Загрузка и кеширование `steps.htm` |
| `src/scenarioParameterUtils.ts` | Нормализация и дефолты параметров |
| `media/phaseSwitcher.*` | UI Test Manager (`Менеджер тестов`) |
| `media/yamlParameters.*` | UI менеджера параметров |

## 2) Основной runtime-поток

1. Extension активируется (`onStartupFinished`).
2. Инициализируется кеш сценариев на основе `yamlSourceDirectory`.
3. Подключаются completion/hover/diagnostics.
4. Регистрируются команды `kotTestToolkit.*`.
5. На события редактора (`open/change/save/close`) срабатывают локальные обработчики.

## 3) Save pipeline (ключевая логика)

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

## 5) Test Manager (`Менеджер тестов`): backend + frontend

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

## 7) Менеджер параметров (webview)

Функциональные части:

- СППР-параметры (для `yaml_parameters.json`);
- дополнительные VA-параметры (runtime overlay);
- `GlobalVars`.

Хранение:

- используется SecretStorage для состояния менеджера.

## 8) Где расширять функционал

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

### Добавить пункт в Test Manager (`Менеджер тестов`)

1. Добавить UI-элемент в `media/phaseSwitcher.html/js`.
2. Проложить `postMessage` в backend.
3. Обработать сообщение в `src/phaseSwitcher.ts`.
4. Обновить модели состояния и l10n.

## 9) Что проверять после изменений

Минимум:

1. `npm run compile`
2. Проверить в VS Code:
   - completion/hover;
   - diagnostics + quick fix;
   - save-pipeline;
   - Test Manager (чекбоксы -> build filter, build/run/statuses);
   - менеджер параметров (все вкладки, импорт/экспорт).

## 10) Что важно не ломать

- Инкрементальность кеша: избегать полных пересканирований без необходимости.
- Производительность diagnostics на больших проектах.
- Корректность stale-статусов после изменения сценариев.
- Совместимость с обоими языками UI (RU/EN).
- Стабильность webview-состояний при скрытии/повторном открытии панели.
