# KOT for 1C — Документация по коду расширения (RU)

<p align="center">
  <a href="../README.md">← Назад в README</a> | <a href="./DEVELOPMENT.en.md">English version</a>
</p>

Этот документ описывает внутреннюю архитектуру расширения, основные модули, потоки данных и точки расширения.

## 1) Точка входа и жизненный цикл

- Основной entrypoint: `src/extension.ts`
- Активация: `onStartupFinished` (см. `package.json`)
- В `activate()` происходит:
  - регистрация webview-панели Phase Switcher;
  - eager-инициализация кеша сценариев;
  - регистрация completion/hover/diagnostics providers;
  - регистрация команд (`kotTestToolkit.*`);
  - подписка на события `open/change/save/close` для пост-обработки сценариев.

## 2) Карта модулей

| Файл | Назначение |
|---|---|
| `src/extension.ts` | Оркестрация: регистрация провайдеров/команд, save-pipeline, декорации описания |
| `src/phaseSwitcher.ts` | Webview Phase Switcher + сборка + кеш сценариев + инкрементальные обновления кеша |
| `src/workspaceScanner.ts` | Полное сканирование `paths.yamlSourceDirectory` и сбор `TestInfo` |
| `src/completionProvider.ts` | IntelliSense шагов Gherkin и вызовов вложенных сценариев |
| `src/hoverProvider.ts` | Hover по шагам и вызовам сценариев (описание, метрики, примеры) |
| `src/scenarioDiagnostics.ts` | Диагностика, quick fix, локальный/связанный/глобальный проход |
| `src/commandHandlers.ts` | Команды редактирования/навигации/автозаполнения/форматирования |
| `src/phaseSwitcherMetadata.ts` | Парсинг и миграция `KOTМетаданные`, dual-read legacy-тегов |
| `src/scenarioParameterUtils.ts` | Нормализация параметров, `[]`/кавычки, дефолты из `ПараметрыСценария` |
| `src/scenarioCreator.ts` | Создание главных/вложенных сценариев из шаблонов |
| `src/yamlParametersManager.ts` | UI и хранение параметров сборки (`yaml_parameters.json`) |
| `src/stepsFetcher.ts` | Загрузка библиотеки шагов (`steps.htm`): URL -> cache -> bundle |
| `src/localization.ts` | Локализатор с override (`System/English/Русский`) |
| `src/yamlValidator.ts` | Проверка, что файл — тестовый сценарий (`ТипФайла: "Сценарий"`) |
| `src/types.ts` | Контракт `TestInfo` |

## 3) Ключевая модель данных

- Основной объект: `TestInfo` (`src/types.ts`)
- Содержит:
  - базовые поля сценария (`name`, `uid`, `yamlFileUri`, `relativePath`);
  - данные вызовов/параметров (`nestedScenarioNames`, `parameters`, `parameterDefaults`);
  - данные Phase Switcher (`tabName`, `defaultState`, `order`);
  - поля `scenarioCode*` для диагностики дублей `ДанныеСценария.Код`.

## 4) Кеш сценариев

Источник кеша:
- `scanWorkspaceForTests()` в `src/workspaceScanner.ts` (полный проход по `**/scen.yaml` внутри `paths.yamlSourceDirectory`).

Владелец кеша:
- `PhaseSwitcherProvider` (`src/phaseSwitcher.ts`), поле `_testCache: Map<string, TestInfo>`.

Обновление кеша:
- Полный refresh: `initializeTestCache()` / `refreshTestCacheFromDisk()`.
- Инкрементальный update при save: `upsertScenarioCacheEntryFromDocument()`.
- Dirty-маркировка + отложенный refresh при create/delete/rename/workspace change.

## 5) Save pipeline (обработка при сохранении)

Реализован в `src/extension.ts` через `onDidSaveTextDocument`:

1. Валидация: обрабатываются только scenario-yaml файлы.
2. Debounce-защита: `processingFiles`.
3. Миграция/восстановление `KOTМетаданные` (через `migrateLegacyPhaseSwitcherMetadata`).
4. Расчет dirty-флагов по снимкам (`Имя`, вызовы, параметры).
5. Условный запуск операций:
   - tabs -> spaces;
   - выравнивание Gherkin-таблиц;
   - выравнивание параметров вызовов;
   - автозаполнение `ВложенныеСценарии`;
   - автозаполнение `ПараметрыСценария`.
6. Автосохранение после правок и очистка debounce state.

Почему не всегда перезаполняем секции:
- секции перезаполняются только при релевантных изменениях (`dirty`), либо если секция неполная (`shouldRefill*Section`).

## 6) Диагностика

Провайдер: `ScenarioDiagnosticsProvider` (`src/scenarioDiagnostics.ts`).

Слои проверки:
- локально (активный файл);
- связанные родительские сценарии (по графу вызовов, BFS);
- глобальный workspace scan (ручной, тяжелый).

Особенности:
- `Maybe you meant` для локальной проверки;
- в глобальном скане подсказки отключены для снижения нагрузки;
- отдельная коллекция diagnostics для дублей `Код` (`duplicateCodeDiagnostics`);
- quick fix на:
  - replace with suggested step/call;
  - add missing scenario parameters;
  - add bracket value to parameter exclusions.

## 7) Автодополнение и hover

Completion (`src/completionProvider.ts`):
- шаги Gherkin парсятся из `steps.htm`;
- вызовы вложенных сценариев берутся из `_testCache`;
- при вставке вызова параметры выравниваются по `=`;
- дефолты параметров подставляются из:
  - вызываемого сценария (`parameterDefaults`),
  - локального блока `ПараметрыСценария` текущего файла.

Hover (`src/hoverProvider.ts`):
- шаги: описание + пример с фактическими литералами из строки;
- вызов вложенного сценария: описание из `KOTМетаданные.Описание`, кол-во файлов/параметров/вложенных вызовов;
- есть короткий TTL-кеш hover-метрик.

## 8) Метаданные KOT

Файл: `src/phaseSwitcherMetadata.ts`

Что делает:
- dual-read legacy (`# PhaseSwitcher_*`) и нового блока `KOTМетаданные`;
- миграция legacy -> `KOTМетаданные.PhaseSwitcher`;
- добавление недостающего `Описание`;
- защита от затирания пользовательского содержимого;
- удаление дубликатов top-level блока `KOTМетаданные`.

## 9) Параметры сценария и исключения

- Парсинг/нормализация: `src/scenarioParameterUtils.ts`
- Допустимы значения:
  - в одинарных/двойных кавычках;
  - в квадратных скобках (`[Parameter]`) без кавычек.
- Настройка исключений: `kotTestToolkit.editor.scenarioParameterExclusions`.

Session-cache параметров:
- реализован в `src/commandHandlers.ts` (`scenarioParameterSessionCache`);
- нужен, чтобы сохранять атрибуты/значения блока до закрытия файла, даже если параметры временно удалены из текста.

## 10) Локализация

- Runtime-локализация: `vscode.l10n.t(...)` + файлы `l10n/bundle.l10n*.json`.
- UI contribution-локализация (`package.json`): `package.nls*.json`.
- Override языка: `kotTestToolkit.localization.languageOverride`.

## 11) Производительность: что важно не ломать

- Не запускать тяжелое сканирование на каждое изменение текста.
- Использовать инкрементальные обновления кеша вместо full-rescan, где это возможно.
- Для глобальных операций оставлять ручной запуск из команд.
- Для диагностики связей ограничивать обход графа (`LOCAL_DEPENDENCY_SCAN_MAX_FILES`).
- Для подсказок использовать кеши и дебаунс таймеры.

## 12) Как добавлять новый функционал

Новый тип диагностики:
1. Добавить код диагностики и текст в `scenarioDiagnostics.ts`.
2. Добавить ключи в `l10n/bundle.l10n.json` и `l10n/bundle.l10n.ru.json`.
3. При необходимости добавить quick fix в `provideCodeActions()`.

Новая команда:
1. Добавить команду в `package.json` (`contributes.commands`, меню).
2. Зарегистрировать handler в `activate()` (`extension.ts`).
3. Добавить локализацию для title/сообщений.

## 13) Минимальный smoke-check после изменений

- `npm run compile`
- Проверить в VS Code:
  - автодополнение шагов и вызовов;
  - hover по шагам/вызовам;
  - диагностику и quick fix;
  - save-pipeline (выравнивание/автозаполнение);
  - работу Phase Switcher и сборки.
