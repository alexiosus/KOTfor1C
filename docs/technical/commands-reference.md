# Команды и сочетания клавиш

Справочник создан из manifest KOT. Пользовательские маршруты описаны в [руководстве](../README.md). Наличие команды не означает применимость к любому документу: контекст, состояние сеанса и необходимые файлы проверяются отдельно.

Обновление: `npm run docs:reference`.

## Объявленные сочетания

| Команда | Windows/Linux | macOS | Условие |
|---|---|---|---|
| `kotTestToolkit.openSubscenario` | ctrl+alt+= | cmd+alt+= | editorTextFocus && !editorReadonly |
| `kotTestToolkit.findCurrentFileReferences` | ctrl+alt+J | cmd+alt+J | editorTextFocus && !editorReadonly |
| `kotTestToolkit.insertNestedScenarioRef` | ctrl+alt+N | cmd+alt+N | editorTextFocus && !editorReadonly |
| `kotTestToolkit.insertScenarioParam` | ctrl+alt+M | cmd+alt+M | editorTextFocus && !editorReadonly |
| `kotTestToolkit.insertUid` | ctrl+alt+U | cmd+alt+U | editorTextFocus && !editorReadonly |
| `kotTestToolkit.vanessaControl.oneStep` | f11 | f11 | editorTextFocus && (resourceExtname == .feature \|\| resourceExtname == .yaml) && kotTestToolkit.vanessaControlCanStep && !inDebugMode |

Пользовательские сочетания VS Code могут переопределить эти значения.

## Идентификаторы команд

| Название | Идентификатор |
|---|---|
| KOT - Открыть сценарий | `kotTestToolkit.openSubscenario` |
| KOT - Открыть вложенный сценарий из feature | `kotTestToolkit.openNestedScenarioFromFeature` |
| KOT - Открыть определение проекта | `kotTestToolkit.openProjectDefinition` |
| KOT - Найти вызовы текущего сценария | `kotTestToolkit.findCurrentFileReferences` |
| Создать вложенный сценарий | `kotTestToolkit.createNestedScenario` |
| KOT - Установить категорию вложенного сценария | `kotTestToolkit.setScenarioCategory` |
| Создать главный сценарий | `kotTestToolkit.createMainScenario` |
| Создать главный процесс | `kotTestToolkit.createProcess` |
| Добавить шаги процесса | `kotTestToolkit.addProcessSteps` |
| Редактировать шаги процесса | `kotTestToolkit.editProcessSteps` |
| Создать… | `kotTestToolkit.showCreateScenarioMenu` |
| Создать экспортный сценарий | `kotTestToolkit.createExportScenario` |
| Создать пользовательский шаг | `kotTestToolkit.createUserStep` |
| KOT - Собрать библиотеку пользовательских шагов | `kotTestToolkit.buildUserStepLibrary` |
| KOT - Библиотеки EPF | `kotTestToolkit.manageUserStepLibraries` |
| KOT - Выгрузить исходники EPF-библиотеки | `kotTestToolkit.dumpUserStepLibrary` |
| KOT - Нумерация тестов | `kotTestToolkit.manageTestNumbering` |
| KOT - Управление функциями системы | `kotTestToolkit.manageSystemFunctions` |
| KOT - Управление эталонными базами | `kotTestToolkit.manageEtalonBases` |
| Управление платформами 1С | `kotTestToolkit.managePlatforms` |
| KOT - Вставить блок ВложенныеСценарии | `kotTestToolkit.insertNestedScenarioRef` |
| KOT - Вставить блок ПараметрыСценария | `kotTestToolkit.insertScenarioParam` |
| KOT - Вставить новый UID | `kotTestToolkit.insertUid` |
| Обновить библиотеку | `kotTestToolkit.refreshGherkinSteps` |
| KOT - Заменить табы на пробелы | `kotTestToolkit.replaceTabsWithSpacesYaml` |
| KOT - Заполнить секцию ВложенныеСценарии | `kotTestToolkit.checkAndFillNestedScenarios` |
| KOT - Заполнить секцию ПараметрыСценария | `kotTestToolkit.checkAndFillScriptParameters` |
| KOT - Открыть MXL файл в редакторе | `kotTestToolkit.openMxlFileFromExplorer` |
| KOT - Открыть MXL файл в редакторе | `kotTestToolkit.openMxlFile` |
| KOT - Показать файл в проводнике VS Code | `kotTestToolkit.revealFileInExplorer` |
| KOT - Показать файл в системном проводнике | `kotTestToolkit.revealFileInOS` |
| KOT - Открыть папку files текущего сценария | `kotTestToolkit.openCurrentScenarioFilesFolder` |
| KOT - Открыть папку сборки | `kotTestToolkit.openBuildFolder` |
| KOT - Включить демо-режим (Менеджер тестов) | `kotTestToolkit.enableDemoMode` |
| KOT - Задать демо-состояние для сценария | `kotTestToolkit.setDemoStateForScenario` |
| Собрать архив FirstLaunch | `kotTestToolkit.createFirstLaunchZip` |
| Открыть параметры сборки и запуска | `kotTestToolkit.openYamlParametersManager` |
| KOT - Открыть Исследователь форм 1С | `kotTestToolkit.openFormExplorer` |
| KOT - Открыть библиотеку | `kotTestToolkit.openStepLibrary` |
| KOT - Открыть Менеджер баз | `kotTestToolkit.openInfobaseManager` |
| Открыть Vanessa Automation | `kotTestToolkit.openVanessa` |
| Настроить клиентов отладки Vanessa | `kotTestToolkit.configureVanessaDebugClients` |
| Подсвечивать связанные сценарии | `kotTestToolkit.toggleTestManagerRelationshipHighlight` |
| ✓ Подсвечивать связанные сценарии | `kotTestToolkit.toggleTestManagerRelationshipHighlightChecked` |
| Показывать только связанные сценарии | `kotTestToolkit.toggleTestManagerRelationshipFilter` |
| ✓ Показывать только связанные сценарии | `kotTestToolkit.toggleTestManagerRelationshipFilterChecked` |
| Все тесты | `kotTestToolkit.setTestManagerStatusFilterAll` |
| ✓ Все тесты | `kotTestToolkit.setTestManagerStatusFilterAllChecked` |
| Собранные тесты | `kotTestToolkit.setTestManagerStatusFilterBuilt` |
| ✓ Собранные тесты | `kotTestToolkit.setTestManagerStatusFilterBuiltChecked` |
| Выполняющиеся тесты | `kotTestToolkit.setTestManagerStatusFilterRunning` |
| ✓ Выполняющиеся тесты | `kotTestToolkit.setTestManagerStatusFilterRunningChecked` |
| Подсвечивать связанные сценарии | `kotTestToolkit.toggleStepLibraryRelationshipHighlight` |
| ✓ Подсвечивать связанные сценарии | `kotTestToolkit.toggleStepLibraryRelationshipHighlightChecked` |
| Показывать только связанные сценарии | `kotTestToolkit.toggleStepLibraryRelationshipFilter` |
| ✓ Показывать только связанные сценарии | `kotTestToolkit.toggleStepLibraryRelationshipFilterChecked` |
| Обновить библиотеку | `kotTestToolkit.refreshStepLibrarySidebar` |
| Обновить базы | `kotTestToolkit.refreshInfobaseSidebar` |
| Создать базу | `kotTestToolkit.createInfobase` |
| Обновить тесты | `kotTestToolkit.refreshPhaseSwitcher` |
| Развернуть или свернуть все группы тестов | `kotTestToolkit.toggleTestManagerGroups` |
| Развернуть или свернуть все группы библиотеки | `kotTestToolkit.toggleStepLibraryGroups` |
| Открыть AI-отчёт по изменениям конфигурации | `kotTestToolkit.openConfigurationDiffReport` |
| Открыть AI-ревью тестов | `kotTestToolkit.openTestReviewReport` |
| Открыть настройки расширения | `kotTestToolkit.openSettings` |
| KOT - Запустить мост Исследователя форм (режим TestClient) | `kotTestToolkit.startFormExplorerBridge` |
| KOT - Исправить проблемы сценария | `kotTestToolkit.fixScenarioIssues` |
| KOT - Выполнить сканирование диагностики по проекту | `kotTestToolkit.scanWorkspaceDiagnostics` |
| KOT - Открыть сценарий в Vanessa (ручная отладка) | `kotTestToolkit.openScenarioInVanessaManual` |
| Исправить и проверить измененные сценарии (безопасный пакетный режим) | `kotTestToolkit.processQueuedScenarioFiles` |
| Исправить и проверить все сценарии в yamlSourceDirectory (высокая нагрузка) | `kotTestToolkit.processAllScenarioFiles` |
| Отменить пакетное исправление сценариев | `kotTestToolkit.cancelScenarioRepair` |
| KOT - Добавить открытый сценарий в избранное | `kotTestToolkit.addActiveScenarioToFavorites` |
| KOT - Убрать открытый сценарий из избранного | `kotTestToolkit.removeActiveScenarioFromFavorites` |
| KOT - Добавить/убрать открытый сценарий в избранное | `kotTestToolkit.toggleActiveScenarioFavorite` |
| KOT - Показать избранные сценарии | `kotTestToolkit.showFavoriteScenarios` |
| KOT - Изменить имя главного сценария | `kotTestToolkit.renameScenarioFromEditor` |
| KOT - Изменить код вложенного сценария | `kotTestToolkit.changeNestedScenarioCode` |
| KOT - Изменить имя вложенного сценария | `kotTestToolkit.changeNestedScenarioName` |
| KOT - Сгенерировать описание KOTМетаданные через AI | `kotTestToolkit.generateScenarioDescriptionWithAi` |
| Сгенерировать AI-отчет по diff конфигурации для тестировщика | `kotTestToolkit.generateConfigurationDiffImpactReportWithAi` |
| Сделать AI-ревью измененных тестов | `kotTestToolkit.reviewChangedTestsWithAi` |
| KOT - Отслеживать прогон по логу для открытого feature | `kotTestToolkit.trackScenarioRunByFeatureLog` |
| KOT - Переключить отслеживаемый прогон для открытого feature | `kotTestToolkit.switchTrackedScenarioRunForFeature` |
| KOT - Остановить отслеживание прогонов для открытого feature | `kotTestToolkit.stopTrackedScenarioRunForFeature` |
| KOT - Отслеживать прогон по открытому log-файлу | `kotTestToolkit.trackScenarioRunFromOpenedLogFile` |
| Создать feature-файл | `kotTestToolkit.createFeature` |
| Создать параметры запуска Vanessa (JSON) | `kotTestToolkit.generateFeatureJson` |
| Запустить feature в Vanessa | `kotTestToolkit.runFeature` |
| Переименовать процесс | `kotTestToolkit.renameProcessFromEditor` |
| Изменить код процесса | `kotTestToolkit.changeProcessCodeFromEditor` |
| Открыть настройку запуска процесса | `kotTestToolkit.openProcessTestSettingsFromEditor` |
| Изменить связанный процесс | `kotTestToolkit.changeProcessTestSettingsFromEditor` |
| Добавить запись параметра или тега | `kotTestToolkit.addCompilerYamlBlock` |
| Открыть метаданные проекта | `kotTestToolkit.openProjectMetadata` |
| Открыть свойства теста | `kotTestToolkit.openScenarioEditor` |
| Изменить группу сценария | `kotTestToolkit.changeScenarioGroup` |
| KOT - Переключить кнопки действий в редакторе | `kotTestToolkit.toggleEditorActionButtons` |
| Открыть папку files текущего сценария | `kotTestToolkit.editorMenu.openCurrentScenarioFilesFolder` |
| Открыть MXL файл в редакторе | `kotTestToolkit.editorMenu.openMxlFile` |
| Показать файл в проводнике VS Code | `kotTestToolkit.editorMenu.revealFileInExplorer` |
| Показать файл в системном проводнике | `kotTestToolkit.editorMenu.revealFileInOS` |
| Создать вложенный сценарий | `kotTestToolkit.editorMenu.createNestedScenario` |
| Создать главный сценарий | `kotTestToolkit.editorMenu.createMainScenario` |
| Создать feature-файл | `kotTestToolkit.editorMenu.createFeature` |
| Главный процесс | `kotTestToolkit.editorMenu.createProcess` |
| Редактировать шаги процесса | `kotTestToolkit.editorMenu.editProcessSteps` |
| Изменить имя главного сценария | `kotTestToolkit.editorMenu.renameScenarioFromEditor` |
| Изменить имя вложенного сценария | `kotTestToolkit.editorMenu.changeNestedScenarioName` |
| Изменить код вложенного сценария | `kotTestToolkit.editorMenu.changeNestedScenarioCode` |
| Заполнить секцию ВложенныеСценарии | `kotTestToolkit.editorMenu.checkAndFillNestedScenarios` |
| Заполнить секцию ПараметрыСценария | `kotTestToolkit.editorMenu.checkAndFillScriptParameters` |
| Сгенерировать описание KOTМетаданные через AI | `kotTestToolkit.editorMenu.generateScenarioDescriptionWithAi` |
| Переименовать процесс | `kotTestToolkit.editorMenu.renameProcessFromEditor` |
| Изменить код процесса | `kotTestToolkit.editorMenu.changeProcessCodeFromEditor` |
| Открыть настройку запуска процесса | `kotTestToolkit.editorMenu.openProcessTestSettingsFromEditor` |
| Изменить связанный процесс | `kotTestToolkit.editorMenu.changeProcessTestSettingsFromEditor` |
| Открыть свойства теста | `kotTestToolkit.editorMenu.openScenarioEditor` |
| Открыть охватывающий вложенный сценарий | `kotTestToolkit.editorMenu.openNestedScenarioFromFeature` |
| Отслеживать прогон по логу для открытого feature | `kotTestToolkit.editorMenu.trackScenarioRunByFeatureLog` |
| Переключить отслеживаемый прогон для открытого feature | `kotTestToolkit.editorMenu.switchTrackedScenarioRunForFeature` |
| Остановить отслеживание прогонов для открытого feature | `kotTestToolkit.editorMenu.stopTrackedScenarioRunForFeature` |
| Отслеживать прогон по открытому log-файлу | `kotTestToolkit.editorMenu.trackScenarioRunFromOpenedLogFile` |
| Найти вызовы текущего сценария | `kotTestToolkit.editorMenu.findCurrentFileReferences` |
| Добавить открытый сценарий в избранное | `kotTestToolkit.editorMenu.addActiveScenarioToFavorites` |
| Убрать открытый сценарий из избранного | `kotTestToolkit.editorMenu.removeActiveScenarioFromFavorites` |
| Создать параметры запуска Vanessa (JSON) | `kotTestToolkit.editorMenu.generateFeatureJson` |
| Запустить feature в Vanessa | `kotTestToolkit.editorMenu.runFeature` |
| Управлять Vanessa из VS Code | `kotTestToolkit.vanessaControl` |
| Запустить управляемую Vanessa | `kotTestToolkit.vanessaControl.start` |
| Подключиться к запущенной Vanessa | `kotTestToolkit.vanessaControl.attach` |
| Подключить Vanessa | `kotTestToolkit.vanessaControl.connect` |
| Настройки подключения Vanessa | `kotTestToolkit.vanessaControl.connectionSettings` |
| Vanessa: Клиенты тестирования и сохранённые подключения | `kotTestToolkit.vanessaControl.clients` |
| Остановить выполнение Vanessa | `kotTestToolkit.vanessaControl.stop` |
| Отключиться от Vanessa | `kotTestToolkit.vanessaControl.detach` |
| Vanessa: Выполнить один шаг | `kotTestToolkit.vanessaControl.oneStep` |
| Vanessa: Запустить с этого шага | `kotTestToolkit.vanessaControl.runFromLine` |
| Vanessa: Выполнить один шаг | `kotTestToolkit.editorMenu.vanessaControl.oneStep` |
| Vanessa: Запустить с этого шага | `kotTestToolkit.editorMenu.vanessaControl.runFromLine` |
| Переключить точку останова KOT | `kotTestToolkit.vanessaControl.toggleBreakpoint` |
| Переключить точку останова KOT | `kotTestToolkit.editorMenu.vanessaControl.toggleBreakpoint` |
| Точки останова Vanessa | `kotTestToolkit.vanessaControl.listBreakpoints` |
| Точки останова Vanessa | `kotTestToolkit.editorMenu.vanessaControl.listBreakpoints` |
| Vanessa: Попробовать шаг YAML без сборки | `kotTestToolkit.vanessaControl.tryYamlStep` |
| Vanessa: Попробовать шаг YAML без сборки | `kotTestToolkit.editorMenu.vanessaControl.tryYamlStep` |
| Vanessa: Переменные | `kotTestToolkit.vanessaControl.variables` |
| Обновить переменные Vanessa | `kotTestToolkit.vanessaControl.variables.refresh` |
| Записать строку | `kotTestToolkit.vanessaControl.variables.set` |
| Удалить локальную переменную | `kotTestToolkit.vanessaControl.variables.delete` |
| Vanessa: Выполнить выделенные шаги | `kotTestToolkit.vanessaControl.runSelection` |
| Vanessa: Выполнить выделенные шаги | `kotTestToolkit.editorMenu.vanessaControl.runSelection` |
| Vanessa: Продолжить с точки остановки | `kotTestToolkit.vanessaControl.resume` |
| Выполнить шаг YAML по карте сборки | `kotTestToolkit.vanessaControl.oneCompiledStep` |
| Выполнить шаг YAML по карте сборки | `kotTestToolkit.editorMenu.vanessaControl.oneCompiledStep` |
| Начать запись действий | `kotTestToolkit.vanessaControl.recording.start` |
| Остановить запись и вставить шаги | `kotTestToolkit.vanessaControl.recording.stop` |
| Вставить полученные шаги сюда | `kotTestToolkit.vanessaControl.recording.insertHere` |
| Копировать полученные шаги | `kotTestToolkit.vanessaControl.recording.copy` |
| Получить проверку формы из Vanessa | `kotTestToolkit.vanessaControl.formChecks` |
| Получить шаги Vanessa для текущего элемента клиента | `kotTestToolkit.vanessaControl.formSuggestions` |
| Начать запись действий | `kotTestToolkit.editorMenu.vanessaControl.recording.start` |
| Остановить запись и вставить шаги | `kotTestToolkit.editorMenu.vanessaControl.recording.stop` |
| Получить проверку формы из Vanessa | `kotTestToolkit.editorMenu.vanessaControl.formChecks` |
| Получить шаги Vanessa для текущего элемента клиента | `kotTestToolkit.editorMenu.vanessaControl.formSuggestions` |
| Вставить полученные шаги сюда | `kotTestToolkit.editorMenu.vanessaControl.recording.insertHere` |
| Vanessa: Диагностика | `kotTestToolkit.vanessaControl.diagnostics` |
| Vanessa: Найти шаги в работающем сеансе | `kotTestToolkit.vanessaControl.searchRuntimeSteps` |
| Vanessa: Проверить синтаксис feature в работающем сеансе | `kotTestToolkit.vanessaControl.checkRuntimeSyntax` |
| Преобразовать формат сценария СППР… | `kotTestToolkit.convertScenarioFormat` |
| Преобразовать YAML-сценарии в feature + meta… | `kotTestToolkit.convertScenarioFormatsBatch` |
| Преобразовать формат сценария СППР… | `kotTestToolkit.editorMenu.convertScenarioFormat` |
| Создать вложенный процесс | `kotTestToolkit.createNestedProcess` |
| Преобразования… | `kotTestToolkit.convertScenario` |
| Главный ↔ вложенный сценарий или процесс | `kotTestToolkit.convertScenarioRole` |
| Преобразовать вложенный / экспортный сценарий… | `kotTestToolkit.convertCallableScenario` |
| Преобразования… | `kotTestToolkit.editorMenu.convertScenario` |
| Настроить проект | `kotTestToolkit.startSetup` |
