# Справочник настроек

Создан из `package.json` и локализации KOT. Для редактирования используйте [страницу настроек](../guides/first-run-settings.md). Значения, идентификаторы и варианты здесь не переименовываются.

Обновление: `npm run docs:reference`.

Области: `window` — окно; `resource` — ресурс/папка; остальные значения следуют VS Code configuration scope. В обычном окне одной папки проектные настройки соответствуют Workspace. В multi-root доступность Folder зависит от scope.

## Редактор и подсказки

### Язык интерфейса KOT

`kotTestToolkit.localization.languageOverride`

Язык панелей и страницы настроек KOT (после повторного открытия). Нативные настройки VS Code и контекстные меню используют язык VS Code.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"System"
```

Допустимые значения: `"System"`, `"English"`, `"Русский"`.

### Сворачивать служебные блоки при открытии

`kotTestToolkit.editor.autoCollapseOnOpen`

Автоматически сворачивать секции 'ВложенныеСценарии' и 'ПараметрыСценария' при открытии файла.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Открывать свойства выбранного теста

`kotTestToolkit.editor.autoOpenTestProperties`

Автоматически показывать свойства теста в правой боковой панели при открытии YAML сценария, процесса, настроек запуска или соседних метаданных KOT. Фокус остаётся в редакторе.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Редактировать текст YAML как Gherkin

`kotTestToolkit.editor.useFeatureLanguageModeForScenarioYaml`

Включить Gherkin-подсветку внутри блока `ТекстСценария`, сохраняя сам файл сценария в обычном режиме YAML.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Заменять табуляцию пробелами при сохранении

`kotTestToolkit.editor.autoReplaceTabsWithSpacesOnSave`

Автоматически заменять табуляции на 4 пробела при сохранении YAML файлов.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Выравнивать аргументы вложенных сценариев

`kotTestToolkit.editor.autoAlignNestedScenarioParametersOnSave`

Автоматически выравнивать параметры вызовов вложенных сценариев по знаку '=' при сохранении.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Выравнивать таблицы Gherkin

`kotTestToolkit.editor.autoAlignGherkinTablesOnSave`

Автоматически выравнивать колонки таблиц Gherkin при сохранении YAML-сценариев и feature-файлов.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Обновлять вложенные сценарии по тексту

`kotTestToolkit.editor.autoFillNestedScenariosOnSave`

Автоматически заполнять секцию 'ВложенныеСценарии' недостающими сценариями при сохранении YAML файлов.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Обновлять параметры по тексту

`kotTestToolkit.editor.autoFillScenarioParametersOnSave`

Автоматически заполнять секцию 'ПараметрыСценария' недостающими параметрами при сохранении YAML файлов.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Сообщать об обновлении блоков

`kotTestToolkit.editor.showRefillMessages`

Показывать уведомления при автоматическом перезаполнении секций при сохранении.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Общее поведение кнопок редактора

`kotTestToolkit.editor.showActionButtons`

Показывать кнопки действий KOT в редакторе YAML и feature: настройки запуска, группы, блоки и метаданные.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Показывать кнопки в YAML

`kotTestToolkit.editor.showYamlActionButtons`

Показывать кнопки действий в YAML. Явное значение заменяет прежнюю общую настройку кнопок.

Тип: `"boolean"`. Область: `resource`.

Значение по умолчанию:

```json
false
```

### Показывать кнопки в feature

`kotTestToolkit.editor.showFeatureActionButtons`

Показывать кнопки действий в feature. Явное значение заменяет прежнюю общую настройку кнопок.

Тип: `"boolean"`. Область: `resource`.

Значение по умолчанию:

```json
false
```

### Версия Vanessa для подсказок шагов

`kotTestToolkit.steps.vanessaVersion`

Точная версия Vanessa Automation для этой папки проекта (например, 1.2.043.28). Оставьте пустым для определения по файлу истории изменений рядом с runVanessa.vanessaEpfPath.

Тип: `"string"`. Область: `resource`.

Значение по умолчанию:

```json
""
```

### Источник каталога шагов

`kotTestToolkit.steps.catalogIndexUrl`

HTTPS URL индекса неизменяемых версионных каталогов шагов Vanessa.

Тип: `"string"`. Область: `resource`.

Значение по умолчанию:

```json
"https://raw.githubusercontent.com/alexiosus/KOTfor1C/step-catalogs/index.json"
```

### Отключённые проверки

`kotTestToolkit.diagnostics.ignoredCodes`

Коды диагностик KOT, которые нужно скрыть для пользователя, рабочей области или отдельной папки. Изменение списка сразу обновляет диагностику.

Тип: `"array"`. Область: `resource`.

Значение по умолчанию:

```json
[]
```

Элементы списка: `kotTestToolkit.unclosedIf`, `kotTestToolkit.unclosedDo`, `kotTestToolkit.unclosedTry`, `kotTestToolkit.unclosedQuote`, `kotTestToolkit.compilerSyntax`, `kotTestToolkit.compilerFormat`, `kotTestToolkit.unknownStep`, `kotTestToolkit.unknownScenario`, `kotTestToolkit.ambiguousDefinition`, `kotTestToolkit.extraScenarioParameter`, `kotTestToolkit.missingScenarioParameter`, `kotTestToolkit.missingQuotes`, `kotTestToolkit.incompleteBlock`, `kotTestToolkit.defaultDescription`, `kotTestToolkit.duplicateScenarioCode`.

### Проверять вызывающие сценарии

`kotTestToolkit.editor.checkRelatedParentScenarios`

Автоматически проверять связанные родительские сценарии при открытии/сохранении файла сценария.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Подсвечивать связи в Менеджере тестов

`kotTestToolkit.phaseSwitcher.highlightAffectedMainScenarios`

Подсвечивать в Менеджере тестов затронутые главные сценарии относительно активного файла сценария.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Показывать только связанные тесты

`kotTestToolkit.phaseSwitcher.filterRelatedScenarios`

Показывать только тесты, связанные с текущим открытым файлом сценария.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Подсвечивать связи в Библиотеке

`kotTestToolkit.stepLibrary.highlightScenarioRelationships`

Подсвечивать элементы библиотеки, связанные с текущим открытым файлом сценария.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Показывать только связанные элементы Библиотеки

`kotTestToolkit.stepLibrary.filterRelatedScenarios`

Показывать только элементы библиотеки, связанные с текущим открытым файлом сценария.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Добавлять новые сценарии в избранное

`kotTestToolkit.phaseSwitcher.autoAddNewScenariosToFavorites`

Автоматически добавлять новые созданные сценарии в избранное.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

## Новые тесты и команда

### Проекты

`kotTestToolkit.catalogs.projects`

Проекты. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Изменения синхронизируются с `.kot/property-catalogs.yml` (`projects`) и передаются через Git.

Тип: `"array"`. Область: `resource`.

Значение по умолчанию:

```json
[]
```

### Ответственные за сценарии

`kotTestToolkit.catalogs.responsibles`

Ответственные. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Общий файл: `.kot/property-catalogs.yml` (`responsibles`). Здесь имена ответственных, без учётных данных клиентов тестирования.

Тип: `"array"`. Область: `resource`.

Значение по умолчанию:

```json
[]
```

### Группы отчёта первого уровня

`kotTestToolkit.catalogs.reportLevel1`

Уровни отчёта 1. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Синхронизируются с `.kot/property-catalogs.yml` (`reportLevel1`).

Тип: `"array"`. Область: `resource`.

Значение по умолчанию:

```json
[]
```

### Группы отчёта второго уровня

`kotTestToolkit.catalogs.reportLevel2`

Уровни отчёта 2. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Синхронизируются с `.kot/property-catalogs.yml` (`reportLevel2`).

Тип: `"array"`. Область: `resource`.

Значение по умолчанию:

```json
[]
```

### Категории сценариев

`kotTestToolkit.catalogs.categories`

Категории. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Синхронизируются с `.kot/property-catalogs.yml` (`categories`). Изменение каталога не переименовывает поля существующих сценариев.

Тип: `"array"`. Область: `resource`.

Значение по умолчанию:

```json
[]
```

### Функции системы

`kotTestToolkit.catalogs.systemFunctions`

Функции системы: **имя → UID**. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Для новой функции оставьте UID пустым: KOT создаст его и сохранит в `.kot/property-catalogs.yml`. При переименовании сохраняйте существующий UID.

Тип: `"object"`. Область: `resource`.

Значение по умолчанию:

```json
{}
```

### Авторские серии кодов

`kotTestToolkit.numbering.series`

Серии тестировщиков: **шестизначный префикс → автор**, например `000012` → `Имя тестировщика`. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Общий файл: `.kot/test-numbering.yml`; выданные номера сохраняются автоматически. Серию с выданными номерами удалить нельзя.

Тип: `"object"`. Область: `resource`.

Значение по умолчанию:

```json
{}
```

### Моя авторская серия

`kotTestToolkit.numbering.prefix`

Предпочтительная серия автора, например `000012`. Храните личный выбор в Пользовательских настройках. Мастер всегда предлагает выбрать автора и серию, показывая текущую первой; `manual` предпочитает ручной ввод кода. Серии и их авторы хранятся в общем каталоге проекта. Ответственный сценария — отдельное поле.

Тип: `"string"`. Область: `machine-overridable`.

Значение по умолчанию:

```json
""
```

### Язык новых сценариев

`kotTestToolkit.editor.newScenarioLanguage`

Язык для новых сценариев (строка #language в тексте сценария).

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"en"
```

Допустимые значения: `"en"`, `"ru"`.

### Проект для новых сценариев

`kotTestToolkit.newScenarioDefaults.project`

Значение по умолчанию для `ДанныеСценария.Проект` в новых YAML-сценариях.

Задает проектный контекст сценария. В терминах СППР соответствует проекту-владельцу сценария.

Это начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"Drive"
```

### Начальный список функций системы

`kotTestToolkit.newScenarioDefaults.systemFunctions`

Функции системы хранятся в `.kot/property-catalogs.yml` проекта, в разделе `systemFunctions`. Этот файл можно передавать через Git.

Эта настройка используется только для первого заполнения отсутствующего раздела. Имена и UID сохраняются; после переноса редактируйте каталог через менеджер или общий YAML. Первая запись каталога считается значением по умолчанию.

[Открыть менеджер функций системы](command:kotTestToolkit.manageSystemFunctions)

Тип: `"array"`. Область: `window`.

Значение по умолчанию:

```json
[
  {
    "name": "Drive automation testing",
    "uid": "98999f57-13dc-11e8-aed1-005056a5c4e8"
  }
]
```

### Разрешать использование в других функциях

`kotTestToolkit.newScenarioDefaults.allowCrossFunctionUsage`

Значение по умолчанию для `ДанныеСценария.РазрешеноИспользоватьВДругихФункциях` в новых YAML-сценариях.

Управляет тем, можно ли вызывать сценарий из сценариев другой функции системы.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Профиль пользователя новых сценариев

`kotTestToolkit.newScenarioDefaults.userProfile`

Профиль пользователя по умолчанию для новых YAML-сценариев и файлов настройки запуска.

Используется как `ПрофильПользователя` и в сценарии, и в `test.yaml`. Влияет на выбор профиля TestClient при сборке и выполнении.

Это начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"Administrator"
```

### Группа отчёта первого уровня по умолчанию

`kotTestToolkit.newScenarioDefaults.reportLevel1`

Значение по умолчанию для `ДанныеСценария.УровеньОтчета1` в новых YAML-сценариях.

Используется для генерации заголовка `#report.feature` в итоговом feature-файле.

Это начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"Drive"
```

### Группа отчёта главного сценария по умолчанию

`kotTestToolkit.newScenarioDefaults.mainReportLevel2`

Значение по умолчанию для `ДанныеСценария.УровеньОтчета2` в новых главных YAML-сценариях.

Используется для генерации заголовка `#report.story` в итоговом feature-файле для главных сценариев.

Это начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"Parent"
```

### Группа отчёта вложенного сценария по умолчанию

`kotTestToolkit.newScenarioDefaults.nestedReportLevel2`

Значение по умолчанию для `ДанныеСценария.УровеньОтчета2` в новых вложенных YAML-сценариях.

Используется для генерации заголовка `#report.story` в итоговом feature-файле для вложенных сценариев.

Это начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"Tests"
```

### Свой шаблон нового feature-файла

`kotTestToolkit.editor.newFeatureTemplatePath`

Пользовательский шаблон новой feature: абсолютный путь или путь относительно проекта; поддерживает ${workspaceFolder}. Пустое значение включает стандартный шаблон Vanessa ru/en. Подстановки: {{featureTitle}}, {{scenarioTitle}}, {{language}}.

Тип: `"string"`. Область: `resource`.

Значение по умолчанию:

```json
""
```

### Формат новых сценариев СППР

`kotTestToolkit.newScenarioDefaults.format`

Предпочтительный формат нового сценария СППР: `legacy` — scen.yaml; `native` — meta.yaml и scen.feature. Мастер позволяет изменить выбор для каждого сценария.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"native"
```

Допустимые значения: `"legacy"`, `"native"`.

### Преобразовывать старый YAML при сохранении

`kotTestToolkit.editor.autoMigrateScenarioYamlOnSave`

При сохранении преобразовывать старый scen.yaml в scen.feature + meta.yaml. По умолчанию выключено. Несохранённые соседние файлы препятствуют конвертации.

Тип: `"boolean"`. Область: `resource`.

Значение по умолчанию:

```json
false
```

## Компиляция СППР

### Обработка компилятора СППР

`kotTestToolkit.paths.buildScenarioBddEpf`

Относительный путь к обработке СборкаТекстовСценариев.epf для преобразования YAML в Feature

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"build/BuildScenarioBDD.epf"
```

### Показывать специальные команды 1cDrive

`kotTestToolkit.assembleScript.showDriveFeatures`

Показывать в UI сборки функции 1C:Drive (Build FL и переключатель режима учета).

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Показывать журнал при компиляции

`kotTestToolkit.assembleScript.showOutputPanel`

Автоматически показывать панель Output при запуске сборки тестов.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Подробный технический журнал

`kotTestToolkit.output.advancedLogging`

Показывать дополнительные технические детали в Output (для диагностики).

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Открыть параметры сборки и запуска

`kotTestToolkit.paths.openBuildScenarioParametersManager`

Нажмите кнопку ниже, чтобы открыть панель параметров сборки и запуска, где вы можете настроить параметры тестов.

[Открыть параметры сборки и запуска](command:kotTestToolkit.openYamlParametersManager)

Тип: `"null"`. Область: `window`.

Значение по умолчанию:

```json
null
```

### Исключать выключенные тесты переносом файлов

`kotTestToolkit.legacy.enableDisabledTestsDirectoryMoveOnBuild`

Режим совместимости: при сборке временно переносить test/*.yaml отключённых сценариев во временный каталог ОС и возвращать после сборки.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

## Vanessa и выполнение

### Обработка Vanessa Automation

`kotTestToolkit.runVanessa.vanessaEpfPath`

Путь к vanessa-automation.epf для встроенного запуска Vanessa из Менеджера тестов: абсолютный или относительно папки проекта.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"tools/vanessa/vanessa-automation.epf"
```

### Папка результатов выполнения Vanessa

`kotTestToolkit.runVanessa.runtimeDirectory`

Каталог служебных файлов Vanessa: журналов выполнения и состояния сценариев. Путь абсолютный или относительно папки проекта.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
".vscode/kot-runtime/vanessa"
```

### Показывать журнал при запуске

`kotTestToolkit.runVanessa.showOutputPanel`

Автоматически показывать панель Output при запуске Vanessa Automation.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Собственная команда запуска Vanessa

`kotTestToolkit.runVanessa.commandTemplate`

Опциональный шаблон команды для кнопки запуска в Менеджере тестов.

Доступные подстановки:
- `${scenarioName}` / `${scenarioNameQuoted}`
- `${featurePath}` / `${featurePathQuoted}`
- `${jsonPath}` / `${jsonPathQuoted}`
- `${workspaceRoot}` / `${workspaceRootQuoted}`

Если оставить пустым, расширение использует встроенный запуск Vanessa (1C + vanessa-automation.epf + StartFeaturePlayer).

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
""
```

### Способ выполнения тестов

`kotTestToolkit.runVanessa.executionMode`

Режим Run в Test Manager. По умолчанию `mcp`: использует согласованный активный сеанс или готовит менеджер с JSON теста и оставляет Vanessa открытой после результата. Для несовпадающих настроек предлагает выбор. Требуются совместимые MCP-компоненты; автоматического перехода к другому режиму при ошибке нет. Шаблон команды имеет приоритет.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"mcp"
```

Допустимые значения: `"process"`, `"mcp"`.

### Как часто обновлять журнал выполнения

`kotTestToolkit.runVanessa.liveLogRefreshSeconds`

Интервал обновления журнала выполняемого сценария в секундах.

Тип: `"number"`. Область: `window`.

Значение по умолчанию:

```json
2
```

### Ожидание первых обновлений журнала

`kotTestToolkit.runVanessa.autoDetectMinStartupUpdates`

Минимальное число свежих обновлений журнала на старте для автоматического обнаружения и отслеживания прогона Vanessa.

Тип: `"number"`. Область: `window`.

Значение по умолчанию:

```json
2
```

### Когда считать журнал неактивным

`kotTestToolkit.runVanessa.autoDetectInactivityTimeoutSeconds`

Время без обновлений журнала в секундах, после которого автоматически обнаруженный прогон Vanessa считается неактивным.

Тип: `"number"`. Область: `window`.

Значение по умолчанию:

```json
20
```

### Подключаться к найденному сеансу Vanessa

`kotTestToolkit.vanessaControl.autoAttach`

Автоматически подключаться к единственному найденному локальному MCP-сеансу Vanessa при старте и перед ручным выполнением. Проверяются сохранённые локальные адреса, порт 9876 и, на Windows, слушающие loopback-порты процессов 1С. При нескольких сеансах предлагается выбор. Удалённые адреса выбираются вручную.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Запускать Vanessa при открытии проекта

`kotTestToolkit.vanessaControl.autoStart`

Запускать один управляемый MCP-сеанс Vanessa при активации расширения, если работающий локальный сеанс не найден. Требуются доверенная рабочая область и заполненные настройки запуска служебной базы. По умолчанию выключено; неудачная попытка при активации не повторяется.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Предлагать элементы текущей формы

`kotTestToolkit.vanessaControl.formCompletions`

Читать текущую форму подключённого клиента тестирования для подсказок редактора, даже если Исследователь форм закрыт. Первый подходящий запрос загружает форму; следующие используют общий кеш и проверяют её идентификатор не чаще раза в пять секунд. Выключите, чтобы использовать только формы, уже загруженные в Исследователе форм.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Добавлять сохранённые клиенты тестирования в Vanessa

`kotTestToolkit.vanessaControl.autoAddSavedClients`

Автоматически добавлять отсутствующие сохранённые профили в подключённую Vanessa. Не подключает клиентов и не заменяет конфликтующие или изменённые профили. После отказа повтор возможен через Refresh.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

## Информационные базы и платформы

### Установленные платформы 1С

`kotTestToolkit.platforms.catalog`

Каталог доступных платформ 1С, которые использует KOT при запуске.

Каждый элемент должен содержать `name` и `clientExePath` с путем к `1cv8c.exe`.

Первая запись в списке считается платформой по умолчанию. KOT автоматически заполняет каталог найденными установленными платформами; сначала идет самая свежая обнаруженная версия.

[Открыть менеджер платформ](command:kotTestToolkit.managePlatforms)

Тип: `"array"`. Область: `window`.

Значение по умолчанию:

```json
[]
```

### Спрашивать платформу перед запуском

`kotTestToolkit.platforms.promptForLaunches`

Спрашивать платформу 1С при запуске баз, Исследователя форм и встроенном запуске Vanessa. Если выключено, используется платформа по умолчанию.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
true
```

### Дополнительные каталоги шаблонов 1С

`kotTestToolkit.infobaseManager.templateDirectories`

Дополнительные каталоги установленных шаблонов 1С (tmplts). KOT читает файлы 1cv8.mft: .cf для пустой базы и обновления конфигурации, .dt для демо-базы. Автоматически учитываются ConfigurationTemplatesLocation из 1CEStart.cfg и стандартный каталог шаблонов. Пути обычно задаются в Пользовательских настройках.

Тип: `"array"`. Область: `machine-overridable`.

Значение по умолчанию:

```json
[]
```

### Общие ключи запуска 1С

`kotTestToolkit.startupParams.parameters`

Параметры запуска 1С:Предприятие (разделенные пробелами, например, '/L ru /DisableStartupMessages /Debug')

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"/L ru /DisableStartupMessages /DisableStartupDialogs"
```

## Исследователь формы

### Файл снимка формы

`kotTestToolkit.formExplorer.snapshotPath`

Путь к JSON-файлу снимка формы, который создаёт сеанс моста Исследователя форм. Путь абсолютный или относительно папки проекта.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
".vscode/kot-runtime/form-explorer/form-snapshot.json"
```

### Файловая выгрузка конфигурации

`kotTestToolkit.formExplorer.configurationSourceDirectory`

Каталог исходников конфигурации 1С для дополнения данных Исследователя форм и переходов к исходникам. Путь абсолютный или относительно папки проекта.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"cf"
```

### Папка файлов исследования формы

`kotTestToolkit.formExplorer.generatedArtifactsDirectory`

Каталог служебных файлов Исследователя форм: дополнительных данных снимков, файлов моста и статического индекса. Путь абсолютный или относительно папки проекта.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
".vscode/kot-runtime/form-explorer"
```

### Команда подготовки расширения исследования формы

`kotTestToolkit.formExplorer.extensionBuildCommandTemplate`

Необязательный шаблон команды оболочки для сборки расширения Исследователя форм в один клик.

Если оставить пустым на Windows, расширение использует встроенный сборщик через настроенный `1cv8c.exe` и соседний `1cv8.exe`: временная файловая ИБ -> `/LoadConfigFromFiles` для основной конфигурации -> `/LoadConfigFromFiles ... -Extension` для сгенерированного проекта -> `/DumpCfg ... -Extension` в `.cfe`.

Доступные подстановки:
- `${workspaceRoot}` / `${workspaceRootQuoted}`
- `${configurationSourceDir}` / `${configurationSourceDirQuoted}`
- `${generatedArtifactsDir}` / `${generatedArtifactsDirQuoted}`
- `${extensionSourceDir}` / `${extensionSourceDirQuoted}`
- `${cfePath}` / `${cfePathQuoted}`
- `${snapshotPath}` / `${snapshotPathQuoted}`

Задавайте этот шаблон только если хотите заменить встроенный сборщик на `oscript`, `vrunner`, собственные скрипты или другую цепочку сборки 1С.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
""
```

### Как часто проверять изменения формы

`kotTestToolkit.formExplorer.autoRefreshSeconds`

Интервал перечитывания файла снимка формы в секундах, пока панель Исследователя форм открыта.

Тип: `"number"`. Область: `window`.

Значение по умолчанию:

```json
1
```

### Показывать журнал Исследователя формы

`kotTestToolkit.formExplorer.showOutputPanel`

Автоматически показывать панель «Вывод» при подготовке и запуске моста Исследователя форм.

Тип: `"boolean"`. Область: `window`.

Значение по умолчанию:

```json
false
```

### Порт клиента тестирования для моста

`kotTestToolkit.formExplorer.bridge.testClientPort`

Порт TCP для TestClient-соединения между служебной (TestManager) и рабочей базами. Обе стороны должны использовать один порт. По умолчанию: 1538.

Тип: `"number"`. Область: `window`.

Значение по умолчанию:

```json
1538
```

### Как получать данные формы

`kotTestToolkit.formExplorer.source`

Источник Исследователя форм. Автоматический режим использует подключённый совместимый сеанс Vanessa MCP. Режим снимков сохраняет прежний мост, включая локатор и чтение строк таблицы формы.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"auto"
```

Допустимые значения: `"auto"`, `"mcp"`, `"snapshot"`.

## AI-помощь

### Тип AI-сервиса

`kotTestToolkit.ai.apiFormat`

Формат HTTP API, через который расширение обращается к подключенной LLM.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"chatCompletions"
```

Допустимые значения: `"responses"`, `"chatCompletions"`.

### Адрес AI-сервиса

`kotTestToolkit.ai.baseUrl`

Базовый URL подключенной LLM.

Примеры для локальных серверов:
- `http://localhost:11434/v1`
- `http://127.0.0.1:1234/v1`

Примеры для облачных провайдеров:
- `https://api.openai.com/v1`
- `https://generativelanguage.googleapis.com/v1beta/openai`

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"http://localhost:1234/v1"
```

### Версия API сервиса

`kotTestToolkit.ai.apiVersion`

Необязательная версия, добавляемая как `?api-version=...` к каждому URL запроса. Используйте только если её требует сервер.

Для Azure OpenAI `/openai/v1`, стандартного OpenAI и локальных провайдеров оставьте пустым. Старые адреса развёртываний Azure имеют другой контракт авторизации: версия API не меняет Bearer-заголовок KOT на `api-key`.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
""
```

### Ключ доступа к AI-сервису

`kotTestToolkit.ai.apiKey`

API-ключ подключенной LLM.

Значение хранится в `settings.json` в открытом виде, поэтому по возможности используйте отдельный ключ с минимально необходимыми правами. Для локальных провайдеров, которые не проверяют авторизацию, достаточно любого непустого значения, например `local`.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"local"
```

### Модель

`kotTestToolkit.ai.model`

Имя модели для генерации описаний сценариев.

По умолчанию задано имя легкой локальной модели для Ollama-совместимого сценария: `qwen3:4b`. При необходимости замените на точный id модели, который доступен у вашего локального или облачного провайдера.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"qwen3:4b"
```

### Язык ответов AI

`kotTestToolkit.ai.outputLanguage`

Язык, на котором генерируется описание сценария.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"ru"
```

Допустимые значения: `"ru"`, `"en"`.

### Длина строк в AI-описаниях

`kotTestToolkit.ai.maxLineLength`

Максимальная видимая длина строки для сгенерированного описания с учетом YAML-отступа.

Тип: `"number"`. Область: `window`.

Значение по умолчанию:

```json
100
```

### Время ожидания ответа AI

`kotTestToolkit.ai.timeoutSeconds`

Таймаут AI-запроса на генерацию описания в секундах.

Тип: `"number"`. Область: `window`.

Значение по умолчанию:

```json
180
```

### Дополнительные указания для AI

`kotTestToolkit.ai.systemPrompt`

Необязательная замена встроенного system prompt, который расширение использует при генерации описания сценария в метаданных KOT.

Оставьте пустым, чтобы использовать встроенный prompt, заточенный под YAML-сценарии KOT/1C.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
""
```

## Дополнительные инструменты

### Служебная папка KOT

`kotTestToolkit.runtime.directory`

Путь к служебному каталогу KOT для yaml_parameters.json, журналов и временных результатов сборки. Это отдельный каталог, не FeatureFolder СППР.

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
".vscode/kot-runtime"
```

### Программа 1С для работы с файлами

`kotTestToolkit.paths.fileWorkshopExe`

Полный путь к '1С:Предприятие — работа с файлами' (1cv8fv.exe).

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
"C:\\Program Files (x86)\\1cv8fv\\bin\\1cv8fv.exe"
```

### Инструменты начальной подготовки 1cDrive

`kotTestToolkit.paths.firstLaunchFolder`

Относительный путь к папке набора данных первого запуска (кнопка сборки архива первого запуска показывается только если папка существует)

Тип: `"string"`. Область: `window`.

Значение по умолчанию:

```json
""
```
