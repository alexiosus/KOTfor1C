# Setup (подробная настройка)

Этот документ описывает все пользовательские настройки и команды KOT for 1C на уровне «как настроить и использовать».

## 1) Обязательные зависимости

Для полного цикла (build + run) нужны:

- VS Code `1.98+`.
- Установленная платформа 1С на Windows.
- `СборкаТекстовСценариев.epf` из СППР.
- `vanessa-automation.epf`.
- Доступ к файловой выгрузке конфигурации, если используется `KOT Form Explorer`.

Для MXL-команд отдельно нужен клиент [1С:Предприятие — работа с файлами](https://v8.1c.ru/static/1s-predpriyatie-rabota-s-faylami/) (`1cv8fv.exe`).

## 1.1) Документация (ITS и VA)

- ИТС: параметры и применение обработки `СборкаТекстовСценариев`  
  [https://its.1c.ru/db/sppr2doc#content:124:hdoc](https://its.1c.ru/db/sppr2doc#content:124:hdoc)
- Vanessa Automation: JSON-параметры `VAParams`  
  [https://pr-mex.github.io/vanessa-automation/dev/JsonParams/JsonParamsRU/](https://pr-mex.github.io/vanessa-automation/dev/JsonParams/JsonParamsRU/)

## 2) Минимум для запуска сборки

| Настройка | Обязательно |
|---|---|
| `kotTestToolkit.platforms.catalog` | Нет, если KOT сам нашел установленные платформы; иначе добавьте нужную вручную |
| `kotTestToolkit.paths.buildScenarioBddEpf` | Да |
| `kotTestToolkit.runVanessa.vanessaEpfPath` | Для запуска Vanessa |
| `kotTestToolkit.runtime.directory` | Нет, если устраивает default `.vscode/kot-runtime`; иначе задайте свой runtime-путь для служебных build-файлов |

## 3) Все настройки расширения

Порядок ниже соответствует текущему порядку секций в Settings VS Code.

### 3.1 General settings

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.localization.languageOverride` | `System` | Язык UI расширения (`System` / `English` / `Русский`) |

### 3.2 Editor settings

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.editor.autoCollapseOnOpen` | `true` | Автосворачивание служебных секций при открытии файла |
| `kotTestToolkit.editor.useFeatureLanguageModeForScenarioYaml` | `true` | Автопереключение `scen.yaml` в language mode `Feature/Gherkin` для подсветки синтаксиса |
| `kotTestToolkit.editor.autoReplaceTabsWithSpacesOnSave` | `true` | Замена табов пробелами при сохранении |
| `kotTestToolkit.editor.autoAlignNestedScenarioParametersOnSave` | `true` | Выравнивание параметров вызова сценариев по `=` |
| `kotTestToolkit.editor.autoAlignGherkinTablesOnSave` | `true` | Выравнивание таблиц Gherkin |
| `kotTestToolkit.editor.autoFillNestedScenariosOnSave` | `true` | Автоподдержка секции `ВложенныеСценарии` |
| `kotTestToolkit.editor.autoFillScenarioParametersOnSave` | `true` | Автоподдержка секции `ПараметрыСценария` |
| `kotTestToolkit.editor.showRefillMessages` | `true` | Показывать уведомления о перезаполнении секций |

### 3.3 New scenario defaults

Эти настройки использует мастер создания новых сценариев.

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.editor.newScenarioLanguage` | `en` | Язык новых сценариев (`#language: en/ru`) |
| `kotTestToolkit.newScenarioDefaults.project` | `Drive` | Значение по умолчанию для `ДанныеСценария.Проект` |
| `kotTestToolkit.newScenarioDefaults.systemFunctions` | `[{"name":"Drive automation testing","uid":"98999f57-13dc-11e8-aed1-005056a5c4e8"}]` | Список доступных функций системы для новых сценариев; первая запись считается значением по умолчанию |
| `kotTestToolkit.newScenarioDefaults.allowCrossFunctionUsage` | `true` | Значение по умолчанию для `ДанныеСценария.РазрешеноИспользоватьВДругихФункциях` |
| `kotTestToolkit.newScenarioDefaults.userProfile` | `Administrator` | Значение по умолчанию для `ДанныеСценария.ПрофильПользователя` |
| `kotTestToolkit.newScenarioDefaults.reportLevel1` | `Drive` | Значение по умолчанию для `ДанныеСценария.УровеньОтчета1` |
| `kotTestToolkit.newScenarioDefaults.mainReportLevel2` | `Parent` | Значение по умолчанию для `ДанныеСценария.УровеньОтчета2` у главного сценария |
| `kotTestToolkit.newScenarioDefaults.nestedReportLevel2` | `Tests` | Значение по умолчанию для `ДанныеСценария.УровеньОтчета2` у вложенного сценария |

Подробнее о том, как эти значения попадают в `scen.yaml` / `test.yaml` и какие поля шапки они заполняют:
[`blocks/scenario-creation.md`](./blocks/scenario-creation.md)

### 3.4 Diagnostics and Steps Library

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.steps.externalUrl` | `https://raw.githubusercontent.com/kakoytochelik/KOTfor1C/main/res/steps.htm` | Источник `steps.htm` для библиотеки шагов |
| `kotTestToolkit.editor.checkRelatedParentScenarios` | `true` | Проверять связанные родительские сценарии вместе с активным |

### 3.5 Test Manager and UI (Менеджер тестов и UI)

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.phaseSwitcher.highlightAffectedMainScenarios` | `true` | Подсвечивать главные сценарии, затронутые текущим открытым файлом |
| `kotTestToolkit.phaseSwitcher.autoAddNewScenariosToFavorites` | `true` | Автодобавление новых сценариев в избранное |

### 3.6 Test Assembly settings

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.paths.buildScenarioBddEpf` | `build/BuildScenarioBDD.epf` | Путь к EPF сборки `СборкаТекстовСценариев` |
| `kotTestToolkit.assembleScript.showDriveFeatures` | `false` | Показывать/скрывать 1C:Drive-специфичные элементы UI (`Build FL`, `Accounting mode` в выпадающем меню `Build tests`) |
| `kotTestToolkit.assembleScript.showOutputPanel` | `false` | Автооткрытие Output при сборке |
| `kotTestToolkit.output.advancedLogging` | `false` | Расширенные технические логи |
| `kotTestToolkit.paths.openBuildScenarioParametersManager` | `-` | Кнопка-переход к менеджеру параметров в Settings |

### 3.7 Vanessa Automation Launch

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.runVanessa.vanessaEpfPath` | `tools/vanessa/vanessa-automation.epf` | Путь к EPF Vanessa |
| `kotTestToolkit.runVanessa.runtimeDirectory` | `.vscode/kot-runtime/vanessa` | Папка runtime-файлов (логи/статусы) |
| `kotTestToolkit.runVanessa.showOutputPanel` | `false` | Автооткрытие Output при запуске Vanessa |
| `kotTestToolkit.runVanessa.commandTemplate` | `""` | Кастомный shell-шаблон запуска (optional override) |
| `kotTestToolkit.runVanessa.liveLogRefreshSeconds` | `2` | Интервал обновления live-лога |
| `kotTestToolkit.runVanessa.autoDetectMinStartupUpdates` | `2` | Сколько свежих обновлений run-лога нужно на старте, чтобы фоновый монитор посчитал прогон реальным |
| `kotTestToolkit.runVanessa.autoDetectInactivityTimeoutSeconds` | `20` | Через сколько секунд без обновлений run-лога автоопределенный трекинг снимается как неактивный |

Плейсхолдеры для `runVanessa.commandTemplate`:

- `${scenarioName}` / `${scenarioNameQuoted}`
- `${featurePath}` / `${featurePathQuoted}`
- `${jsonPath}` / `${jsonPathQuoted}`
- `${workspaceRoot}` / `${workspaceRootQuoted}`

Рекомендация: в путях и строковых аргументах используйте `*Quoted` варианты, чтобы корректно обрабатывать пробелы и спецсимволы.

### 3.8 KOT Form Explorer (beta)

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.formExplorer.snapshotPath` | `.vscode/kot-runtime/form-explorer/form-snapshot.json` | Базовый путь к snapshot-файлу формы; KOT сам резолвит актуальный session-specific snapshot runtime-адаптера |
| `kotTestToolkit.formExplorer.configurationSourceDirectory` | `cf` | Папка файловой выгрузки конфигурации, которая используется для static enrichment и сборки адаптера Form Explorer |
| `kotTestToolkit.formExplorer.generatedArtifactsDirectory` | `.vscode/kot-runtime/form-explorer` | Папка сгенерированных артефактов и builder-ИБ Form Explorer |
| `kotTestToolkit.formExplorer.extensionBuildCommandTemplate` | `""` | Override встроенного builder через внешний скрипт |
| `kotTestToolkit.formExplorer.autoRefreshSeconds` | `1` | Интервал перечитывания snapshot-а в панели |
| `kotTestToolkit.formExplorer.showOutputPanel` | `false` | Автопоказ Output при сборке `.cfe` и установке Form Explorer |

Важно:

- `configurationSourceDirectory` используется для static enrichment всегда, а также как источник сборки runtime в режимах `direct` и `cfe`;
- отдельная builder-ИБ используется только для сценария `cfe`;
- при `Start infobase`, `Open with Form Explorer` и ручной установке расширения KOT спрашивает режим установки:
  `direct` выбран по умолчанию и строго рекомендуется только когда база соответствует текущей ветке или хотя бы не сильно отличается от нее;
  `cfe` - промежуточный режим через builder-ИБ и пакет `.cfe`;
  `target` - самый медленный, но самый точный режим: KOT сначала выгружает конфигурацию самой выбранной базы, а для файловых ИБ пытается ускорить этот шаг через `ibcmd`.

### 3.9 1C platform settings

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.platforms.catalog` | `[]` | Каталог платформ 1С для запусков; если пуст, KOT пытается заполнить его автоматически найденными установленными версиями |
| `kotTestToolkit.platforms.promptForLaunches` | `true` | Спрашивать платформу при запуске баз, Form Explorer и встроенной Vanessa |

### 3.10 1C startup parameters

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.startupParams.parameters` | `/L ru /DisableStartupMessages /DisableStartupDialogs` | Строка параметров запуска 1С (используется прежде всего для базы сборщика сценариев) |

Примечание:

- для отдельной базы эти параметры можно переопределить через `KOT Infobase Manager` (`Edit base` -> `Edit launch keys`);
- если для базы переопределение не задано, ключи не используются, но можно выбрать значение из `kotTestToolkit.startupParams.parameters`.

### 3.11 System paths settings

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.runtime.directory` | `.vscode/kot-runtime` | Служебная runtime-папка KOT для `yaml_parameters.json`, логов и временных build-артефактов; не совпадает по смыслу с СППР `FeatureFolder` |
| `kotTestToolkit.paths.fileWorkshopExe` | `C:\Program Files (x86)\1cv8fv\bin\1cv8fv.exe` | Путь к File Workshop для MXL |
| `kotTestToolkit.paths.firstLaunchFolder` | `""` | Папка FirstLaunch (кнопка `Build FL` показывается, если включены Drive-функции, путь задан и папка существует) |

### 3.12 Legacy support

| Ключ | Default | Назначение |
|---|---|---|
| `kotTestToolkit.editor.autoEnsureKotMetadataForMainScenarios` | `true` | Автодобавление/восстановление `KOTМетаданные` для всех типов сценариев при save/repair |
| `kotTestToolkit.editor.enableLegacyMetadataMigrationForMainScenarios` | `true` | Опциональная миграция legacy-тегов `# PhaseSwitcher_*` в `KOTМетаданные` только для главных сценариев (работает при включенном `autoEnsureKotMetadataForMainScenarios`) |
| `kotTestToolkit.legacy.enableDisabledTestsDirectoryMoveOnBuild` | `false` | Опциональный legacy-режим: при `Build tests` временно переносить `test/*.yaml` выключенных сценариев в системную temp-папку и возвращать их после завершения сборки |

## 4) Менеджер параметров: как работает

Открыть: в панели Менеджера тестов иконка "`{ }`" или команда `KOT - Open Build Scenario Parameters Manager` (`KOT - Открыть Менеджер параметров Сборки Сценариев`).

Вкладки:

1. **СППР**: параметры для `yaml_parameters.json` (используются обработкой `СборкаТекстовСценариев`).
2. **Доп. параметры Vanessa**: ключи VAParams, которые СППР не покрывает полностью.
3. **GlobalVars**: пользовательские глобальные переменные для запуска.

Важная логика приоритета:

- для совпадающих ключей базово приоритет у значения из СППР;
- для точечного переопределения используйте `Override existing value` в доп. параметрах;
- `GlobalVars` тоже могут точечно перезаписывать существующее значение через `Override existing value`.

Минимум для рабочей сборки feature:

- `ScenarioFolder` или `TestFolder`;
- `FeatureFolder`;
- `VanessaFolder`;
- один launch-путь: `LaunchDBFolder` / `TestClientDBPath` / `InfobasePath` / `TestClientDB`;
- `ModelDBSettings`, если включен `AuthCompile=true`.

KOT показывает этот минимум прямо во вкладке `СППР` и валидирует его при автосохранении и перед предпросмотром `yaml_parameters.json`.

Дополнительно во вкладке `СППР`:

- строки `ScenarioFolder`, `FeatureFolder`, `VanessaFolder`, `ModelDBSettings`, `AuthCompile` и launch-база закреплены и не удаляются;
- `AuthCompile` трактуется как строгая проверка наличия auth-данных, а не как источник логинов/паролей;
- если загружен JSON с `TestFolder`, в UI он нормализуется в `ScenarioFolder`;
- остальные поддерживаемые ключи СППР можно добавлять из встроенного каталога с описанием;
- для модифицированной обработки можно добавлять свои custom-строки;
- менеджер параметров поддерживает профили наборов параметров с быстрым переключением;
- сохранение идет автоматически, а в шапке показывается `Updated at`;
- при автосохранении KOT синхронизирует внутренний корень сканирования из `ScenarioFolder` и запускает пересканирование Test Manager.

Подробнее:
- В репозитории есть пример файла настроек СППР для ознакомления/адаптации под свои нужды: [yaml_parameters.json](../res/yaml_parameters.json)
- Справка по параметрам обработки `СборкаТекстовСценариев` (СППР): [Официальный портал ИТС](https://its.1c.ru/db/sppr2doc#content:124:hdoc)

## 5) Каталог команд

### 5.1 Навигация и создание

- `KOT - Open scenario` (`KOT - Открыть сценарий`)
- `KOT - Open nested scenario from feature` (`KOT - Открыть вложенный сценарий из feature`)
- `KOT - Find references to current scenario` (`KOT - Найти вызовы текущего сценария`)
- `KOT - Create nested scenario` (`KOT - Создать вложенный сценарий`)
- `KOT - Create main scenario` (`KOT - Создать главный сценарий`)
- `KOT - Add or remove current scenario from favorites` (`KOT - Добавить/убрать открытый сценарий в избранное`)
- `KOT - Show favorite scenarios` (`KOT - Показать избранные сценарии`)

### 5.2 Диагностика и редактирование

- `KOT - Fix scenario issues` (`KOT - Исправить проблемы сценария`)
- `KOT - Repair and validate changed scenarios (safe batch)` (`KOT - Исправить и проверить измененные сценарии (безопасный пакетный режим)`)
- `KOT - Repair and validate all scenarios in YAML source directory (high load)` (`KOT - Исправить и проверить все сценарии в yamlSourceDirectory (высокая нагрузка)`)
- `KOT - Cancel scenario repair` (`KOT - Отменить пакетное исправление сценариев`)
- `KOT - Change main scenario name` (`KOT - Изменить имя главного сценария`)
- `KOT - Change nested scenario name` (`KOT - Изменить имя вложенного сценария`)
- `KOT - Change nested scenario code` (`KOT - Изменить код вложенного сценария`)
- `KOT - Fill NestedScenarios section` (`KOT - Заполнить секцию ВложенныеСценарии`)
- `KOT - Fill ScenarioParameters section` (`KOT - Заполнить секцию ПараметрыСценария`)
- `KOT - Replace tabs with spaces` (`KOT - Заменить табы на пробелы`)
- `KOT - Scan workspace diagnostics` (`KOT - Выполнить сканирование диагностики по проекту`)
- `KOT - Refresh steps library` (`KOT - Обновить библиотеку шагов`)
- `KOT - Insert new UID` (`KOT - Вставить новый UID`)

### 5.3 Работа с файлами

- `KOT - Open MXL file in editor` (`KOT - Открыть MXL файл в редакторе`)
- `KOT - Reveal file in VS Code Explorer` (`KOT - Показать файл в проводнике VS Code`)
- `KOT - Reveal file in OS file manager` (`KOT - Показать файл в системном проводнике`)

### 5.4 Сборка и запуск

- `KOT - Open Build Scenario Parameters Manager` (`KOT - Открыть Менеджер параметров Сборки Сценариев`)
- `KOT - Open Infobase Manager` (`KOT - Открыть Менеджер баз`)
- `KOT - Manage platforms` (`KOT - Управление платформами`)
- `KOT - Open 1C Form Explorer` (`KOT - Открыть Исследователь форм 1С`)
- `KOT - Generate Form Explorer extension project` (`KOT - Сгенерировать проект расширения Form Explorer`)
- `KOT - Build Form Explorer .cfe` (`KOT - Собрать .cfe для Form Explorer`)
- `KOT - Install Form Explorer extension into infobase` (`KOT - Установить расширение Form Explorer в базу`)
- `KOT - Open build folder` (`KOT - Открыть папку сборки`)
- `KOT - Create FirstLaunch archive` (`KOT - Собрать архив FirstLaunch`)
- `KOT - Open scenario in Vanessa (manual debug)` (`KOT - Открыть сценарий в Vanessa (ручная отладка)`)
- `KOT - Track scenario run by log for opened feature` (`KOT - Отслеживать прогон по логу для открытого feature`)
- `KOT - Switch tracked run for opened feature` (`KOT - Переключить отслеживаемый прогон для открытого feature`)
- `KOT - Stop tracked runs for opened feature` (`KOT - Остановить отслеживание прогонов для открытого feature`)
- `KOT - Track run by opened log file` (`KOT - Отслеживать прогон по открытому log-файлу`)
