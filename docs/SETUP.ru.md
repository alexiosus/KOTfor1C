# KOT for 1C — Техническая настройка (RU)

<p align="center">
  <a href="../README.md">← Назад в README</a> | <a href="./SETUP.en.md">English version</a>
</p>

Подробный технический справочник по настройкам и командам расширения.

## 1) Что это за документ

Этот файл описывает системные пути, параметры сборки, диагностику, команды и ограничения.

## 2) Ссылки на ИТС

- Обработка `СборкаТекстовСценариев.epf` из СППР и параметры для сборки:
  - [ИТС](https://its.1c.ru/db/sppr2doc#content:124:hdoc)

## 3) Минимум для старта

| Параметр | Что указать | Зачем | Обязательно |
|---|---|---|---|
| `kotTestToolkit.paths.yamlSourceDirectory` | Путь к папке исходных YAML-сценариев внутри репозитория | Источник сценариев для кеша, навигации и диагностики | Да |
| `kotTestToolkit.paths.oneCEnterpriseExe` | Полный путь к `1cv8.exe` (Windows) или `1cestart` (macOS) | Запуск процессов 1С при сборке | Для сборки |
| `kotTestToolkit.paths.buildScenarioBddEpf` | Путь к `BuildScenarioBDD.epf` / `СборкаТекстовСценариев.epf` | Конвертация YAML в `.feature` | Для сборки |
| `kotTestToolkit.assembleScript.buildPath` | Папка для выходных `.feature` | Куда писать результаты сборки | Для сборки |
| `kotTestToolkit.paths.emptyInfobase` | Путь к пустой файловой ИБ | База для запуска обработки сборки | Для сборки |

## 4) Системные пути: что к чему и зачем

| Параметр | Что указать | Где используется | Обязательно | Примечание |
|---|---|---|---|---|
| `kotTestToolkit.paths.emptyInfobase` | Каталог пустой файловой ИБ | Сборка тестов | Для сборки | Обычно абсолютный путь |
| `kotTestToolkit.assembleScript.buildPath` | Папка назначения результатов | Сборка тестов | Для сборки | Обычно абсолютный путь |
| `kotTestToolkit.paths.oneCEnterpriseExe` | Путь к исполняемому файлу платформы 1С | Сборка и запуск обработки | Для сборки | `1cv8.exe` или `1cestart` |
| `kotTestToolkit.paths.fileWorkshopExe` | Путь к `1cv8fv.exe` | Команда открытия MXL | Нет | Нужен только для MXL-команд |
| `kotTestToolkit.paths.buildScenarioBddEpf` | Путь к `BuildScenarioBDD.epf` / `СборкаТекстовСценариев.epf` | Сборка `.feature` | Для сборки | Относительный путь от корня репозитория |
| `kotTestToolkit.paths.yamlSourceDirectory` | Папка YAML-сценариев | Кеш сценариев, диагностика, автодополнение | Да | Рекомендуется держать только нужные YAML тесты |
| `kotTestToolkit.paths.disabledTestsDirectory` | Папка отключенных тестов | Операции Phase Switcher (`Apply`) | Для Phase Switcher | Обычно зеркалирует структуру YAML source |
| `kotTestToolkit.paths.firstLaunchFolder` | Папка данных FirstLaunch | Кнопка/операция сборки архива FirstLaunch | Нет | **Сценарий 1C:Drive (для региональных поставок)** |

## 5) Остальные настройки

### Редактор и диагностика

| Параметр | Назначение |
|---|---|
| `kotTestToolkit.localization.languageOverride` | Язык UI расширения |
| `kotTestToolkit.steps.externalUrl` | URL источника `steps.htm` (Библиотека шагов Vanessa Automation) |
| `kotTestToolkit.editor.autoCollapseOnOpen` | Сворачивать блоки `ПараметрыСценария` и `ВложенныеСценарии` при открытии файла |
| `kotTestToolkit.editor.autoReplaceTabsWithSpacesOnSave` | Замена табов на пробелы при сохранении файла |
| `kotTestToolkit.editor.autoAlignNestedScenarioParametersOnSave` | Выравнивание параметров вызовов сценариев по `=` |
| `kotTestToolkit.editor.autoAlignGherkinTablesOnSave` | Выравнивание таблиц Gherkin |
| `kotTestToolkit.editor.autoFillNestedScenariosOnSave` | Автозаполнение блока `ВложенныеСценарии` |
| `kotTestToolkit.editor.autoFillScenarioParametersOnSave` | Автозаполнение блока `ПараметрыСценария` |
| `kotTestToolkit.editor.scenarioParameterExclusions` | Исключения для значений в `[]`, против ложнного распознавания параметров |
| `kotTestToolkit.editor.showRefillMessages` | Уведомления о перезаполнении блоков |
| `kotTestToolkit.editor.checkRelatedParentScenarios` | Проверка ошибок связанных родительских сценариев |

### Параметры запуска/сборки

| Параметр | Назначение |
|---|---|
| `kotTestToolkit.assembleScript.showOutputPanel` | Открывать ли `Output` при старте сборки |
| `kotTestToolkit.startupParams.parameters` | Параметры запуска процесса 1С |

## 6) Команды (ID + человекочитаемое название)

Большинство команд доступны через палитру команд; часть также через контекстное меню редактора/Explorer.

### Навигация и создание сценариев

| Command ID | Команда в UI | Что делает |
|---|---|---|
| `kotTestToolkit.openSubscenario` | `KOT - Открыть сценарий` | Открывает вызываемый сценарий по строке вызова |
| `kotTestToolkit.findCurrentFileReferences` | `KOT - Найти вызовы текущего сценария` | Показывает, где используется текущий сценарий |
| `kotTestToolkit.createNestedScenario` | `KOT - Создать вложенный сценарий` | Создает вложенный сценарий по шаблону |
| `kotTestToolkit.createMainScenario` | `KOT - Создать главный сценарий` | Создает главный сценарий по шаблону |

### Диагностика, блоки и форматирование

| Command ID | Команда в UI | Что делает |
|---|---|---|
| `kotTestToolkit.fixScenarioIssues` | `KOT - Исправить проблемы сценария` | Применяет пакет исправлений форматирования (отступы) |
| `kotTestToolkit.checkAndFillNestedScenarios` | `KOT - Заполнить секцию ВложенныеСценарии` | Перезаполняет блок `ВложенныеСценарии` |
| `kotTestToolkit.checkAndFillScriptParameters` | `KOT - Заполнить секцию ПараметрыСценария` | Перезаполняет блок `ПараметрыСценария` |
| `kotTestToolkit.replaceTabsWithSpacesYaml` | `KOT - Заменить табы на пробелы` | Нормализует табы в YAML |
| `kotTestToolkit.addScenarioParameterExclusion` | `KOT - Добавить исключение параметра сценария` | Добавляет выделенный фрагмент в исключения параметров |
| `kotTestToolkit.scanWorkspaceDiagnostics` | `KOT - Выполнить сканирование диагностики по проекту` | Полный глобальный проход диагностики (тяжелая операция) |
| `kotTestToolkit.refreshGherkinSteps` | `KOT - Обновить библиотеку шагов` | Перезагружает библиотеку Gherkin-шагов |
| `kotTestToolkit.insertUid` | `KOT - Вставить новый UID` | Вставляет новый UUID |

### Работа с файлами

| Command ID | Команда в UI | Что делает |
|---|---|---|
| `kotTestToolkit.openMxlFile` | `KOT - Открыть MXL файл в редакторе` | Ищет MXL по выделенному имени и открывает через File Workshop |
| `kotTestToolkit.openMxlFileFromExplorer` | `KOT - Открыть MXL файл в редакторе` | Открывает MXL из контекстного меню в боковой панели Explorer |
| `kotTestToolkit.revealFileInExplorer` | `KOT - Показать файл в проводнике VS Code` | Находит и выделяет файл в боковой панели Explorer |
| `kotTestToolkit.revealFileInOS` | `KOT - Показать файл в системном проводнике` | Открывает путь к файлу в проводнике ОС |

### Сборка

| Command ID | Команда в UI | Что делает |
|---|---|---|
| `kotTestToolkit.openYamlParametersManager` | `KOT - Открыть Менеджер параметров Сборки Сценариев` | Открывает UI управления `yaml_parameters.json` |
| `kotTestToolkit.createFirstLaunchZip` | `KOT - Собрать архив FirstLaunch` | Собирает архив FirstLaunch (1C:Drive-сценарий) |
| `kotTestToolkit.openBuildFolder` | `KOT - Открыть папку сборки` | Открывает папку результатов сборки |

## 7) Горячие клавиши

В этом расширении есть дефолтные биндинги, но лучше назначать/переопределять их под команду через VS Code:

- `Preferences: Open Keyboard Shortcuts`
- `Preferences: Open Keyboard Shortcuts (JSON)`

## 8) Производительность

- Для постоянной работы используйте локальную диагностику (активный файл + связанные сценарии).
- Глобальное сканирование (`scanWorkspaceDiagnostics`) запускайте вручную, когда действительно нужно.

## 9) Ограничения

- macOS: открытие MXL в клик недоступно, так как отсутствует клиент редактора.
- Linux: работа плагина не гарантируется (не проверялось).
