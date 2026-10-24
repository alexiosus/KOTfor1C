// Generated prototype snapshot of settings-map.json; does not store real configuration.
window.KOT_SETTINGS_MODEL = {
  "version": 1,
  "status": "design-prototype",
  "sections": [
    {
      "id": "editor",
      "title": "Редактор и подсказки",
      "description": "Подсказки, сохранение и вид панелей"
    },
    {
      "id": "project",
      "title": "Новые тесты и команда",
      "description": "Язык, формат, справочники и авторские серии"
    },
    {
      "id": "build",
      "title": "Компиляция СППР",
      "description": "Компилятор и результаты компиляции"
    },
    {
      "id": "vanessa",
      "title": "Vanessa и выполнение",
      "description": "Подключение, запуск и результаты"
    },
    {
      "id": "infobases",
      "title": "Информационные базы и платформы",
      "description": "Версии 1С, шаблоны и ключи запуска"
    },
    {
      "id": "forms",
      "title": "Исследователь формы",
      "description": "Данные формы и обновление элементов"
    },
    {
      "id": "ai",
      "title": "AI-помощь",
      "description": "Подключение сервиса и параметры ответов"
    },
    {
      "id": "advanced",
      "title": "Дополнительные инструменты",
      "description": "Служебные папки и внешние программы"
    }
  ],
  "settings": [
    {
      "key": "kotTestToolkit.localization.languageOverride",
      "label": "Язык интерфейса KOT",
      "section": "editor",
      "advanced": false,
      "type": "string",
      "default": "System",
      "description": "Выбор языка интерфейса расширения (может потребоваться перезагрузка панели). Не влияет язык страницы настроек и контекстного меню.",
      "preferredScope": "user",
      "enum": [
        "System",
        "English",
        "Русский"
      ],
      "hint": "Выбор языка интерфейса расширения (может потребоваться перезагрузка панели).",
      "optionLabels": [
        "Как в VS Code",
        "English",
        "Русский"
      ]
    },
    {
      "key": "kotTestToolkit.editor.autoCollapseOnOpen",
      "label": "Сворачивать служебные блоки при открытии",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Автоматически сворачивать секции 'ВложенныеСценарии' и 'ПараметрыСценария' при открытии файла.",
      "preferredScope": "user",
      "hint": "Автоматически сворачивать секции 'ВложенныеСценарии' и 'ПараметрыСценария' при открытии файла."
    },
    {
      "key": "kotTestToolkit.editor.autoOpenTestProperties",
      "label": "Открывать свойства выбранного теста",
      "section": "editor",
      "advanced": false,
      "type": "boolean",
      "default": true,
      "description": "Автоматически показывать свойства теста в правой боковой панели при открытии YAML сценария, процесса, настроек запуска или соседних метаданных KOT. Фокус остаётся в редакторе.",
      "preferredScope": "user",
      "hint": "Автоматически показывать свойства теста в правой боковой панели при открытии YAML сценария, процесса, настроек запуска или соседних метаданных KOT."
    },
    {
      "key": "kotTestToolkit.editor.useFeatureLanguageModeForScenarioYaml",
      "label": "Редактировать текст YAML как Gherkin",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Включить Gherkin-подсветку внутри блока `ТекстСценария`, сохраняя сам файл сценария в обычном режиме YAML.",
      "preferredScope": "user",
      "hint": "Включить Gherkin-подсветку внутри блока `ТекстСценария`, сохраняя сам файл сценария в обычном режиме YAML."
    },
    {
      "key": "kotTestToolkit.editor.autoReplaceTabsWithSpacesOnSave",
      "label": "Заменять табуляцию пробелами при сохранении",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Автоматически заменять табуляции на 4 пробела при сохранении YAML файлов.",
      "preferredScope": "user",
      "hint": "Автоматически заменять табуляции на 4 пробела при сохранении YAML файлов."
    },
    {
      "key": "kotTestToolkit.editor.autoAlignNestedScenarioParametersOnSave",
      "label": "Выравнивать аргументы вложенных сценариев",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Автоматически выравнивать параметры вызовов вложенных сценариев по знаку '=' при сохранении.",
      "preferredScope": "user",
      "hint": "Автоматически выравнивать параметры вызовов вложенных сценариев по знаку '=' при сохранении."
    },
    {
      "key": "kotTestToolkit.editor.autoAlignGherkinTablesOnSave",
      "label": "Выравнивать таблицы Gherkin",
      "section": "editor",
      "advanced": false,
      "type": "boolean",
      "default": true,
      "description": "Автоматически выравнивать колонки таблиц Gherkin при сохранении YAML-сценариев и feature-файлов.",
      "preferredScope": "user",
      "hint": "Автоматически выравнивать колонки таблиц Gherkin при сохранении YAML-сценариев и feature-файлов."
    },
    {
      "key": "kotTestToolkit.editor.autoFillNestedScenariosOnSave",
      "label": "Обновлять вложенные сценарии по тексту",
      "section": "editor",
      "advanced": false,
      "type": "boolean",
      "default": true,
      "description": "Автоматически заполнять секцию 'ВложенныеСценарии' недостающими сценариями при сохранении YAML файлов.",
      "preferredScope": "user",
      "hint": "Автоматически заполнять секцию 'ВложенныеСценарии' недостающими сценариями при сохранении YAML файлов."
    },
    {
      "key": "kotTestToolkit.editor.autoFillScenarioParametersOnSave",
      "label": "Обновлять параметры по тексту",
      "section": "editor",
      "advanced": false,
      "type": "boolean",
      "default": true,
      "description": "Автоматически заполнять секцию 'ПараметрыСценария' недостающими параметрами при сохранении YAML файлов.",
      "preferredScope": "user",
      "hint": "Автоматически заполнять секцию 'ПараметрыСценария' недостающими параметрами при сохранении YAML файлов."
    },
    {
      "key": "kotTestToolkit.editor.showRefillMessages",
      "label": "Сообщать об обновлении блоков",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Показывать уведомления при автоматическом перезаполнении секций при сохранении.",
      "preferredScope": "user",
      "hint": "Показывать уведомления при автоматическом перезаполнении секций при сохранении."
    },
    {
      "key": "kotTestToolkit.editor.showActionButtons",
      "label": "Общее поведение кнопок редактора",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Показывать кнопки действий KOT в редакторе YAML и feature: настройки запуска, группы, блоки и метаданные.",
      "preferredScope": "user",
      "hint": "Задаёт показ кнопок, пока для YAML или feature не выбрано отдельное значение. Оставлен для существующих настроек; обычно достаточно двух переключателей выше.",
      "compatibility": true
    },
    {
      "key": "kotTestToolkit.editor.showYamlActionButtons",
      "label": "Показывать кнопки в YAML",
      "section": "editor",
      "advanced": false,
      "type": "boolean",
      "default": false,
      "description": "Показывать кнопки действий в YAML. Явное значение заменяет прежнюю общую настройку кнопок.",
      "preferredScope": "user",
      "hint": "Можно использовать общую настройку кнопок или отдельно выбрать показ для этого формата.",
      "inheritsFrom": "kotTestToolkit.editor.showActionButtons"
    },
    {
      "key": "kotTestToolkit.editor.showFeatureActionButtons",
      "label": "Показывать кнопки в feature",
      "section": "editor",
      "advanced": false,
      "type": "boolean",
      "default": false,
      "description": "Показывать кнопки действий в feature. Явное значение заменяет прежнюю общую настройку кнопок.",
      "preferredScope": "user",
      "hint": "Можно использовать общую настройку кнопок или отдельно выбрать показ для этого формата.",
      "inheritsFrom": "kotTestToolkit.editor.showActionButtons"
    },
    {
      "key": "kotTestToolkit.catalogs.projects",
      "label": "Проекты",
      "section": "project",
      "advanced": false,
      "type": "array",
      "default": [],
      "description": "Проекты. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Изменения синхронизируются с `.kot/property-catalogs.yml` (`projects`) и передаются через Git.",
      "preferredScope": "folder",
      "editor": "manager",
      "hint": "Проекты."
    },
    {
      "key": "kotTestToolkit.catalogs.responsibles",
      "label": "Ответственные за сценарии",
      "section": "project",
      "advanced": false,
      "type": "array",
      "default": [],
      "description": "Ответственные. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Общий файл: `.kot/property-catalogs.yml` (`responsibles`). Здесь имена ответственных, без учётных данных клиентов тестирования.",
      "preferredScope": "folder",
      "editor": "manager",
      "hint": "Ответственные."
    },
    {
      "key": "kotTestToolkit.catalogs.reportLevel1",
      "label": "Группы отчёта первого уровня",
      "section": "project",
      "advanced": true,
      "type": "array",
      "default": [],
      "description": "Уровни отчёта 1. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Синхронизируются с `.kot/property-catalogs.yml` (`reportLevel1`).",
      "preferredScope": "folder",
      "editor": "manager",
      "hint": "Уровни отчёта 1."
    },
    {
      "key": "kotTestToolkit.catalogs.reportLevel2",
      "label": "Группы отчёта второго уровня",
      "section": "project",
      "advanced": true,
      "type": "array",
      "default": [],
      "description": "Уровни отчёта 2. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Синхронизируются с `.kot/property-catalogs.yml` (`reportLevel2`).",
      "preferredScope": "folder",
      "editor": "manager",
      "hint": "Уровни отчёта 2."
    },
    {
      "key": "kotTestToolkit.catalogs.categories",
      "label": "Категории сценариев",
      "section": "project",
      "advanced": true,
      "type": "array",
      "default": [],
      "description": "Категории. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Синхронизируются с `.kot/property-catalogs.yml` (`categories`). Изменение каталога не переименовывает поля существующих сценариев.",
      "preferredScope": "folder",
      "editor": "manager",
      "hint": "Категории."
    },
    {
      "key": "kotTestToolkit.catalogs.systemFunctions",
      "label": "Функции системы",
      "section": "project",
      "advanced": false,
      "type": "object",
      "default": {},
      "description": "Функции системы: **имя → UID**. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Для новой функции оставьте UID пустым: KOT создаст его и сохранит в `.kot/property-catalogs.yml`. При переименовании сохраняйте существующий UID.",
      "preferredScope": "folder",
      "editor": "manager",
      "hint": "Функции системы: имя → UID."
    },
    {
      "key": "kotTestToolkit.numbering.series",
      "label": "Авторские серии кодов",
      "section": "project",
      "advanced": false,
      "type": "object",
      "default": {},
      "description": "Серии тестировщиков: **шестизначный префикс → автор**, например `000012` → `Имя тестировщика`. Заполняйте на вкладке **Рабочая область (Workspace)** или **Папка (Folder)**. Общий файл: `.kot/test-numbering.yml`; выданные номера сохраняются автоматически. Серию с выданными номерами удалить нельзя.",
      "preferredScope": "folder",
      "editor": "manager",
      "hint": "Серии тестировщиков: шестизначный префикс → автор, например `000012` → `Имя тестировщика`."
    },
    {
      "key": "kotTestToolkit.numbering.prefix",
      "label": "Моя авторская серия",
      "section": "project",
      "advanced": false,
      "type": "string",
      "default": "",
      "description": "Предпочтительная серия автора, например `000012`. Храните личный выбор в Пользовательских настройках. Мастер всегда предлагает выбрать автора и серию, показывая текущую первой; `manual` предпочитает ручной ввод кода. Серии и их авторы хранятся в общем каталоге проекта. Ответственный сценария — отдельное поле.",
      "preferredScope": "user",
      "hint": "Ваша серия для новых кодов. Это не ответственный за сценарий и не пользователь 1С."
    },
    {
      "key": "kotTestToolkit.editor.newScenarioLanguage",
      "label": "Язык новых сценариев",
      "section": "project",
      "advanced": false,
      "type": "string",
      "default": "en",
      "description": "Язык для новых сценариев (строка #language в тексте сценария).",
      "preferredScope": "folder",
      "enum": [
        "en",
        "ru"
      ],
      "hint": "Язык шагов новых сценариев. Язык записи действий выбирается отдельно в параметрах Vanessa.",
      "optionLabels": [
        "Английский (en)",
        "Русский (ru)"
      ]
    },
    {
      "key": "kotTestToolkit.newScenarioDefaults.project",
      "label": "Проект для новых сценариев",
      "section": "project",
      "advanced": true,
      "type": "string",
      "default": "Drive",
      "description": "Значение по умолчанию для `ДанныеСценария.Проект` в новых YAML-сценариях.\n\nЗадает проектный контекст сценария. В терминах СППР соответствует проекту-владельцу сценария.\n\nЭто начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.",
      "preferredScope": "folder",
      "hint": "Значение по умолчанию для `ДанныеСценария.Проект` в новых YAML-сценариях."
    },
    {
      "key": "kotTestToolkit.newScenarioDefaults.systemFunctions",
      "label": "Начальный список функций системы",
      "section": "project",
      "advanced": true,
      "type": "array",
      "default": [
        {
          "name": "Drive automation testing",
          "uid": "98999f57-13dc-11e8-aed1-005056a5c4e8"
        }
      ],
      "description": "Функции системы хранятся в `.kot/property-catalogs.yml` проекта, в разделе `systemFunctions`. Этот файл можно передавать через Git.\n\nЭта настройка используется только для первого заполнения отсутствующего раздела. Имена и UID сохраняются; после переноса редактируйте каталог через менеджер или общий YAML. Первая запись каталога считается значением по умолчанию.\n\n[Открыть менеджер функций системы](command:kotTestToolkit.manageSystemFunctions)",
      "preferredScope": "folder",
      "hint": "Используется для первого заполнения отсутствующего каталога функций системы. В настроенном проекте редактируйте «Функции системы» через менеджер: здесь менять список не требуется.",
      "compatibility": true
    },
    {
      "key": "kotTestToolkit.newScenarioDefaults.allowCrossFunctionUsage",
      "label": "Разрешать использование в других функциях",
      "section": "project",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Значение по умолчанию для `ДанныеСценария.РазрешеноИспользоватьВДругихФункциях` в новых YAML-сценариях.\n\nУправляет тем, можно ли вызывать сценарий из сценариев другой функции системы.",
      "preferredScope": "folder",
      "hint": "Значение по умолчанию для `ДанныеСценария.РазрешеноИспользоватьВДругихФункциях` в новых YAML-сценариях."
    },
    {
      "key": "kotTestToolkit.newScenarioDefaults.userProfile",
      "label": "Профиль пользователя новых сценариев",
      "section": "project",
      "advanced": true,
      "type": "string",
      "default": "Administrator",
      "description": "Профиль пользователя по умолчанию для новых YAML-сценариев и файлов настройки запуска.\n\nИспользуется как `ПрофильПользователя` и в сценарии, и в `test.yaml`. Влияет на выбор профиля TestClient при сборке и выполнении.\n\nЭто начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.",
      "preferredScope": "folder",
      "hint": "Профиль пользователя по умолчанию для новых YAML-сценариев и файлов настройки запуска."
    },
    {
      "key": "kotTestToolkit.newScenarioDefaults.reportLevel1",
      "label": "Группа отчёта первого уровня по умолчанию",
      "section": "project",
      "advanced": true,
      "type": "string",
      "default": "Drive",
      "description": "Значение по умолчанию для `ДанныеСценария.УровеньОтчета1` в новых YAML-сценариях.\n\nИспользуется для генерации заголовка `#report.feature` в итоговом feature-файле.\n\nЭто начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.",
      "preferredScope": "folder",
      "hint": "Значение по умолчанию для `ДанныеСценария.УровеньОтчета1` в новых YAML-сценариях."
    },
    {
      "key": "kotTestToolkit.newScenarioDefaults.mainReportLevel2",
      "label": "Группа отчёта главного сценария по умолчанию",
      "section": "project",
      "advanced": true,
      "type": "string",
      "default": "Parent",
      "description": "Значение по умолчанию для `ДанныеСценария.УровеньОтчета2` в новых главных YAML-сценариях.\n\nИспользуется для генерации заголовка `#report.story` в итоговом feature-файле для главных сценариев.\n\nЭто начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.",
      "preferredScope": "folder",
      "hint": "Значение по умолчанию для `ДанныеСценария.УровеньОтчета2` в новых главных YAML-сценариях."
    },
    {
      "key": "kotTestToolkit.newScenarioDefaults.nestedReportLevel2",
      "label": "Группа отчёта вложенного сценария по умолчанию",
      "section": "project",
      "advanced": true,
      "type": "string",
      "default": "Tests",
      "description": "Значение по умолчанию для `ДанныеСценария.УровеньОтчета2` в новых вложенных YAML-сценариях.\n\nИспользуется для генерации заголовка `#report.story` в итоговом feature-файле для вложенных сценариев.\n\nЭто начальное значение для мастера, а не список допустимых значений. Общие списки редактируются в «Каталоги проекта и нумерация» и хранятся в .kot.",
      "preferredScope": "folder",
      "hint": "Значение по умолчанию для `ДанныеСценария.УровеньОтчета2` в новых вложенных YAML-сценариях."
    },
    {
      "key": "kotTestToolkit.editor.newFeatureTemplatePath",
      "label": "Свой шаблон нового feature-файла",
      "section": "project",
      "advanced": true,
      "type": "string",
      "default": "",
      "description": "Пользовательский шаблон новой feature: абсолютный путь или путь относительно проекта; поддерживает ${workspaceFolder}. Пустое значение включает стандартный шаблон Vanessa ru/en. Подстановки: {{featureTitle}}, {{scenarioTitle}}, {{language}}.",
      "preferredScope": "folder",
      "hint": "Пользовательский шаблон новой feature: абсолютный путь или путь относительно проекта; поддерживает ${workspaceFolder}.",
      "pathKind": "feature",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.newScenarioDefaults.format",
      "label": "Формат новых сценариев СППР",
      "section": "project",
      "advanced": false,
      "type": "string",
      "default": "legacy",
      "description": "Предпочтительный формат нового сценария СППР: `legacy` — scen.yaml; `native` — meta.yaml и scen.feature. Мастер позволяет изменить выбор для каждого сценария.",
      "preferredScope": "folder",
      "enum": [
        "legacy",
        "native"
      ],
      "hint": "Влияет только на новые сценарии СППР. Формат существующих файлов не меняется.",
      "optionLabels": [
        "Сценарий в одном YAML (scen.yaml)",
        "Текст feature + метаданные YAML (scen.feature + meta.yaml)"
      ]
    },
    {
      "key": "kotTestToolkit.editor.autoMigrateScenarioYamlOnSave",
      "label": "Преобразовывать старый YAML при сохранении",
      "section": "project",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "При сохранении преобразовывать старый scen.yaml в scen.feature + meta.yaml. По умолчанию выключено. Несохранённые соседние файлы препятствуют конвертации.",
      "preferredScope": "folder",
      "hint": "При сохранении преобразовывать старый scen.yaml в scen.feature + meta.yaml."
    },
    {
      "key": "kotTestToolkit.steps.vanessaVersion",
      "label": "Версия Vanessa для подсказок шагов",
      "section": "editor",
      "advanced": false,
      "type": "string",
      "default": "",
      "description": "Точная версия Vanessa Automation для этой папки workspace (например, 1.2.043.28). Оставьте пустым для определения по changelog рядом с runVanessa.vanessaEpfPath.",
      "preferredScope": "folder",
      "hint": "Оставьте пустым: KOT определит версию по docs/Changelog.md рядом с выбранной vanessa-automation.epf. Без подходящего changelog используется последний доступный каталог шагов; точную версию можно задать вручную. Это настройка подсказок, она не обновляет Vanessa.",
      "placeholder": "Автоматически"
    },
    {
      "key": "kotTestToolkit.steps.catalogIndexUrl",
      "label": "Источник каталога шагов",
      "section": "editor",
      "advanced": true,
      "type": "string",
      "default": "https://raw.githubusercontent.com/alexiosus/KOTfor1C/step-catalogs/index.json",
      "description": "HTTPS URL индекса неизменяемых версионных каталогов шагов Vanessa.",
      "preferredScope": "user",
      "hint": "HTTPS URL индекса неизменяемых версионных каталогов шагов Vanessa."
    },
    {
      "key": "kotTestToolkit.diagnostics.ignoredCodes",
      "label": "Отключённые проверки",
      "section": "editor",
      "advanced": true,
      "type": "array",
      "default": [],
      "description": "Коды диагностик KOT, которые нужно скрыть для пользователя, workspace или отдельной папки workspace. Изменение списка сразу обновляет опубликованные диагностики.",
      "preferredScope": "user",
      "hint": "Выберите проверки, сообщения которых нужно скрыть. По умолчанию все проверки включены.",
      "editor": "choices",
      "itemEnum": [
        "kotTestToolkit.unclosedIf",
        "kotTestToolkit.unclosedDo",
        "kotTestToolkit.unclosedTry",
        "kotTestToolkit.unclosedQuote",
        "kotTestToolkit.compilerSyntax",
        "kotTestToolkit.compilerFormat",
        "kotTestToolkit.unknownStep",
        "kotTestToolkit.unknownScenario",
        "kotTestToolkit.ambiguousDefinition",
        "kotTestToolkit.extraScenarioParameter",
        "kotTestToolkit.missingScenarioParameter",
        "kotTestToolkit.missingQuotes",
        "kotTestToolkit.incompleteBlock",
        "kotTestToolkit.defaultDescription",
        "kotTestToolkit.duplicateScenarioCode"
      ],
      "choiceLabels": [
        "Незакрытый блок If",
        "Незакрытый блок Do",
        "Незакрытый блок Try",
        "Незакрытые кавычки",
        "Синтаксис компилятора СППР",
        "Формат исходника СППР",
        "Неизвестный шаг",
        "Неизвестный сценарий",
        "Неоднозначный вызов",
        "Лишний параметр сценария",
        "Недостающий параметр сценария",
        "Отсутствующие кавычки",
        "Неполный блок",
        "Незаполненное описание",
        "Повторяющийся код сценария"
      ]
    },
    {
      "key": "kotTestToolkit.editor.checkRelatedParentScenarios",
      "label": "Проверять вызывающие сценарии",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Автоматически проверять связанные родительские сценарии при открытии/сохранении файла сценария.",
      "preferredScope": "user",
      "hint": "Автоматически проверять связанные родительские сценарии при открытии/сохранении файла сценария."
    },
    {
      "key": "kotTestToolkit.phaseSwitcher.highlightAffectedMainScenarios",
      "label": "Подсвечивать связи в Менеджере тестов",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Подсвечивать в Менеджере тестов затронутые главные сценарии относительно активного файла сценария.",
      "preferredScope": "user",
      "hint": "Подсвечивать в Менеджере тестов затронутые главные сценарии относительно активного файла сценария."
    },
    {
      "key": "kotTestToolkit.phaseSwitcher.filterRelatedScenarios",
      "label": "Показывать только связанные тесты",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Показывать только тесты, связанные с текущим открытым файлом сценария.",
      "preferredScope": "user",
      "hint": "Показывать только тесты, связанные с текущим открытым файлом сценария."
    },
    {
      "key": "kotTestToolkit.stepLibrary.highlightScenarioRelationships",
      "label": "Подсвечивать связи в Библиотеке",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Подсвечивать элементы библиотеки, связанные с текущим открытым файлом сценария.",
      "preferredScope": "user",
      "hint": "Подсвечивать элементы библиотеки, связанные с текущим открытым файлом сценария."
    },
    {
      "key": "kotTestToolkit.stepLibrary.filterRelatedScenarios",
      "label": "Показывать только связанные элементы Библиотеки",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Показывать только элементы библиотеки, связанные с текущим открытым файлом сценария.",
      "preferredScope": "user",
      "hint": "Показывать только элементы библиотеки, связанные с текущим открытым файлом сценария."
    },
    {
      "key": "kotTestToolkit.phaseSwitcher.autoAddNewScenariosToFavorites",
      "label": "Добавлять новые сценарии в избранное",
      "section": "editor",
      "advanced": true,
      "type": "boolean",
      "default": true,
      "description": "Автоматически добавлять новые созданные сценарии в избранное.",
      "preferredScope": "user",
      "hint": "Автоматически добавлять новые созданные сценарии в избранное."
    },
    {
      "key": "kotTestToolkit.paths.buildScenarioBddEpf",
      "label": "Обработка компилятора СППР",
      "section": "build",
      "advanced": false,
      "type": "string",
      "default": "build/BuildScenarioBDD.epf",
      "description": "Относительный путь к обработке СборкаТекстовСценариев.epf для преобразования YAML в Feature",
      "preferredScope": "folder",
      "hint": "В Конфигураторе СППР сохраните обработку СборкаТекстовСценариев в отдельный файл .epf. Положите её в build проекта и выберите здесь. Компилятор нужен для сценариев и процессов СППР.",
      "pathKind": "epf",
      "pathPolicy": "project"
    },
    {
      "key": "kotTestToolkit.assembleScript.showDriveFeatures",
      "label": "Показывать специальные команды 1cDrive",
      "section": "build",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Показывать в UI сборки функции 1C:Drive (Build FL и переключатель режима учета).",
      "preferredScope": "folder",
      "hint": "Показывать в UI сборки функции 1C:Drive (Build FL и переключатель режима учета)."
    },
    {
      "key": "kotTestToolkit.assembleScript.showOutputPanel",
      "label": "Показывать журнал при компиляции",
      "section": "build",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Автоматически показывать панель Output при запуске сборки тестов.",
      "preferredScope": "folder",
      "hint": "Автоматически показывать панель Output при запуске сборки тестов."
    },
    {
      "key": "kotTestToolkit.output.advancedLogging",
      "label": "Подробный технический журнал",
      "section": "build",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Показывать дополнительные технические детали в Output (для диагностики).",
      "preferredScope": "folder",
      "hint": "Показывать дополнительные технические детали в Output (для диагностики)."
    },
    {
      "key": "kotTestToolkit.paths.openBuildScenarioParametersManager",
      "label": "Открыть параметры компиляции и запуска",
      "section": "build",
      "advanced": false,
      "type": "null",
      "default": null,
      "description": "Нажмите кнопку ниже, чтобы открыть панель параметров компиляции и запуска, где вы можете настроить параметры тестов.\n\n[Открыть параметры компиляции и запуска](command:kotTestToolkit.openYamlParametersManager)",
      "preferredScope": "folder",
      "editor": "action",
      "hint": "Профили параметров компилятора, Vanessa и глобальных переменных открываются в существующем менеджере."
    },
    {
      "key": "kotTestToolkit.runVanessa.vanessaEpfPath",
      "label": "Обработка Vanessa Automation",
      "section": "vanessa",
      "advanced": false,
      "type": "string",
      "default": "tools/vanessa/vanessa-automation.epf",
      "description": "Путь к vanessa-automation.epf для встроенного запуска Vanessa из Менеджера тестов (абсолютный или относительный от корня workspace).",
      "preferredScope": "user",
      "hint": "Путь к vanessa-automation.epf для встроенного запуска Vanessa из Менеджера тестов (абсолютный или относительный от корня workspace).",
      "pathKind": "epf",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.runVanessa.runtimeDirectory",
      "label": "Папка результатов выполнения Vanessa",
      "section": "vanessa",
      "advanced": true,
      "type": "string",
      "default": ".vscode/kot-runtime/vanessa",
      "description": "Папка для runtime-файлов Vanessa (лог/статус сценария). Абсолютный путь или относительный от корня workspace.",
      "preferredScope": "folder",
      "hint": "Папка для runtime-файлов Vanessa (лог/статус сценария).",
      "pathKind": "directory",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.runVanessa.showOutputPanel",
      "label": "Показывать журнал при запуске",
      "section": "vanessa",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Автоматически показывать панель Output при запуске Vanessa Automation.",
      "preferredScope": "user",
      "hint": "Автоматически показывать панель Output при запуске Vanessa Automation."
    },
    {
      "key": "kotTestToolkit.runVanessa.commandTemplate",
      "label": "Собственная команда запуска Vanessa",
      "section": "vanessa",
      "advanced": true,
      "type": "string",
      "default": "",
      "description": "Опциональный шаблон команды для кнопки запуска в Менеджере тестов.\n\nДоступные плейсхолдеры:\n- `${scenarioName}` / `${scenarioNameQuoted}`\n- `${featurePath}` / `${featurePathQuoted}`\n- `${jsonPath}` / `${jsonPathQuoted}`\n- `${workspaceRoot}` / `${workspaceRootQuoted}`\n\nЕсли оставить пустым, расширение использует встроенный запуск Vanessa (1C + vanessa-automation.epf + StartFeaturePlayer).",
      "preferredScope": "user",
      "hint": "Опциональный шаблон команды для кнопки запуска в Менеджере тестов."
    },
    {
      "key": "kotTestToolkit.runVanessa.executionMode",
      "label": "Способ выполнения тестов",
      "section": "vanessa",
      "advanced": false,
      "type": "string",
      "default": "mcp",
      "description": "Режим Run в Test Manager. По умолчанию `mcp`: использует согласованный активный сеанс или готовит менеджер с JSON теста и оставляет Vanessa открытой после результата. Для несовпадающих настроек предлагает выбор. Требуются совместимые MCP-компоненты; автоматического перехода к другому режиму при ошибке нет. Шаблон команды имеет приоритет.",
      "preferredScope": "user",
      "enum": [
        "process",
        "mcp"
      ],
      "hint": "Обычно KOT управляет открытой Vanessa и оставляет её доступной после выполнения.",
      "optionLabels": [
        "Запускать отдельный процесс",
        "Управлять открытой Vanessa (MCP)"
      ]
    },
    {
      "key": "kotTestToolkit.runVanessa.liveLogRefreshSeconds",
      "label": "Как часто обновлять журнал выполнения",
      "section": "vanessa",
      "advanced": true,
      "type": "number",
      "default": 2,
      "description": "Интервал обновления live-лога выполняемого сценария в секундах.",
      "preferredScope": "user",
      "hint": "Интервал обновления live-лога выполняемого сценария в секундах."
    },
    {
      "key": "kotTestToolkit.runVanessa.autoDetectMinStartupUpdates",
      "label": "Ожидание первых обновлений журнала",
      "section": "vanessa",
      "advanced": true,
      "type": "number",
      "default": 2,
      "description": "Минимальное число свежих обновлений run-лога на старте, после которого фоновое автоопределение Vanessa начинает трекинг.",
      "preferredScope": "user",
      "hint": "Минимальное число свежих обновлений run-лога на старте, после которого фоновое автоопределение Vanessa начинает трекинг."
    },
    {
      "key": "kotTestToolkit.runVanessa.autoDetectInactivityTimeoutSeconds",
      "label": "Когда считать журнал неактивным",
      "section": "vanessa",
      "advanced": true,
      "type": "number",
      "default": 20,
      "description": "Через сколько секунд без обновлений run-лога автоопределенный прогон Vanessa снимается как неактивный.",
      "preferredScope": "user",
      "hint": "Через сколько секунд без обновлений run-лога автоопределенный прогон Vanessa снимается как неактивный."
    },
    {
      "key": "kotTestToolkit.vanessaControl.autoAttach",
      "label": "Подключаться к найденному сеансу Vanessa",
      "section": "vanessa",
      "advanced": false,
      "type": "boolean",
      "default": true,
      "description": "Автоматически подключаться к единственному найденному локальному MCP-сеансу Vanessa при старте и перед ручным выполнением. Проверяются сохранённые локальные адреса, порт 9876 и, на Windows, слушающие loopback-порты процессов 1С. При нескольких сеансах предлагается выбор. Удалённые адреса выбираются вручную.",
      "preferredScope": "user",
      "hint": "Предложить найденную локальную Vanessa вместо ручного ввода адреса."
    },
    {
      "key": "kotTestToolkit.vanessaControl.autoStart",
      "label": "Запускать Vanessa при открытии проекта",
      "section": "vanessa",
      "advanced": false,
      "type": "boolean",
      "default": false,
      "description": "Запускать один управляемый MCP-сеанс Vanessa при активации расширения, если работающий локальный сеанс не найден. Требуются доверенная рабочая область и заполненные настройки запуска служебной базы. По умолчанию выключено; неудачная попытка при активации не повторяется.",
      "preferredScope": "user",
      "hint": "Подготовить свой сеанс Vanessa при открытии проекта, если подходящий сеанс не найден."
    },
    {
      "key": "kotTestToolkit.vanessaControl.formCompletions",
      "label": "Предлагать элементы текущей формы",
      "section": "vanessa",
      "advanced": false,
      "type": "boolean",
      "default": true,
      "description": "Читать текущую форму подключённого клиента тестирования для подсказок редактора, даже если Form Explorer закрыт. Первый подходящий запрос загружает форму; последующие используют общий кэш и проверяют идентификатор формы не чаще одного раза в пять секунд. Выключите, чтобы использовать только формы, уже загруженные в Form Explorer.",
      "preferredScope": "user",
      "hint": "Предлагать названия элементов текущей формы даже при закрытом Исследователе формы."
    },
    {
      "key": "kotTestToolkit.vanessaControl.autoAddSavedClients",
      "label": "Добавлять сохранённых клиентов в Vanessa",
      "section": "vanessa",
      "advanced": false,
      "type": "boolean",
      "default": true,
      "description": "Автоматически добавлять отсутствующие сохранённые профили в подключённую Vanessa. Не подключает клиентов и не заменяет конфликтующие или изменённые профили. После отказа повтор возможен через Refresh.",
      "preferredScope": "user",
      "hint": "Автоматически добавлять отсутствующие сохранённые профили в подключённую Vanessa."
    },
    {
      "key": "kotTestToolkit.formExplorer.snapshotPath",
      "label": "Файл снимка формы",
      "section": "forms",
      "advanced": true,
      "type": "string",
      "default": ".vscode/kot-runtime/form-explorer/form-snapshot.json",
      "description": "Путь к JSON snapshot-файлу Исследователя форм, который пишет bridge-сессия. Абсолютный путь или относительный от корня workspace.",
      "preferredScope": "user",
      "hint": "Путь к JSON snapshot-файлу Исследователя форм, который пишет bridge-сессия.",
      "pathKind": "json",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.formExplorer.configurationSourceDirectory",
      "label": "Файловая выгрузка конфигурации",
      "section": "forms",
      "advanced": true,
      "type": "string",
      "default": "cf",
      "description": "Путь к каталогу исходников конфигурации 1С, который используется для статического обогащения Form Explorer и привязки к исходникам. Абсолютный путь или относительный от корня workspace.",
      "preferredScope": "folder",
      "hint": "Путь к каталогу исходников конфигурации 1С, который используется для статического обогащения Form Explorer и привязки к исходникам.",
      "pathKind": "directory",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.formExplorer.generatedArtifactsDirectory",
      "label": "Папка файлов исследования формы",
      "section": "forms",
      "advanced": true,
      "type": "string",
      "default": ".vscode/kot-runtime/form-explorer",
      "description": "Каталог для генерируемых артефактов Form Explorer: snapshot-sidecar файлов, bridge-файлов и статического индекса. Абсолютный путь или относительный от корня workspace.",
      "preferredScope": "user",
      "hint": "Каталог для генерируемых артефактов Form Explorer: snapshot-sidecar файлов, bridge-файлов и статического индекса.",
      "pathKind": "directory",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.formExplorer.extensionBuildCommandTemplate",
      "label": "Команда подготовки расширения исследования формы",
      "section": "forms",
      "advanced": true,
      "type": "string",
      "default": "",
      "description": "Необязательный шаблон shell-команды для сборки расширения Form Explorer в один клик.\n\nЕсли оставить пустым на Windows, расширение использует встроенный builder через настроенный `1cv8c.exe` и соседний `1cv8.exe`: временная файловая ИБ -> `/LoadConfigFromFiles` для основной конфигурации -> `/LoadConfigFromFiles ... -Extension` для сгенерированного проекта -> `/DumpCfg ... -Extension` в `.cfe`.\n\nДоступные плейсхолдеры:\n- `${workspaceRoot}` / `${workspaceRootQuoted}`\n- `${configurationSourceDir}` / `${configurationSourceDirQuoted}`\n- `${generatedArtifactsDir}` / `${generatedArtifactsDirQuoted}`\n- `${extensionSourceDir}` / `${extensionSourceDirQuoted}`\n- `${cfePath}` / `${cfePathQuoted}`\n- `${snapshotPath}` / `${snapshotPathQuoted}`\n\nЗадавайте этот шаблон только если хотите заменить встроенный сборщик на `oscript`, `vrunner`, собственные скрипты или другую цепочку сборки 1С.",
      "preferredScope": "user",
      "hint": "Необязательный шаблон shell-команды для сборки расширения Form Explorer в один клик."
    },
    {
      "key": "kotTestToolkit.formExplorer.autoRefreshSeconds",
      "label": "Как часто проверять изменения формы",
      "section": "forms",
      "advanced": false,
      "type": "number",
      "default": 1,
      "description": "Интервал перечитывания snapshot-файла Исследователя форм в секундах, пока панель открыта.",
      "preferredScope": "user",
      "hint": "Интервал перечитывания snapshot-файла Исследователя форм в секундах, пока панель открыта."
    },
    {
      "key": "kotTestToolkit.formExplorer.showOutputPanel",
      "label": "Показывать журнал Исследователя формы",
      "section": "forms",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Автоматически показывать панель Output при подготовке и запуске Form Explorer bridge.",
      "preferredScope": "user",
      "hint": "Автоматически показывать панель Output при подготовке и запуске Form Explorer bridge."
    },
    {
      "key": "kotTestToolkit.formExplorer.bridge.testClientPort",
      "label": "Порт клиента тестирования для моста",
      "section": "forms",
      "advanced": true,
      "type": "number",
      "default": 1538,
      "description": "Порт TCP для TestClient-соединения между служебной (TestManager) и рабочей базами. Обе стороны должны использовать один порт. По умолчанию: 1538.",
      "preferredScope": "user",
      "hint": "Порт TCP для TestClient-соединения между служебной (TestManager) и рабочей базами."
    },
    {
      "key": "kotTestToolkit.formExplorer.source",
      "label": "Как получать данные формы",
      "section": "forms",
      "advanced": false,
      "type": "string",
      "default": "auto",
      "description": "Источник Form Explorer. Автоматический режим использует подключённую совместимую Vanessa MCP. Snapshot сохраняет прежний мост, включая локатор и чтение строк таблицы формы.",
      "preferredScope": "user",
      "enum": [
        "auto",
        "mcp",
        "snapshot"
      ],
      "hint": "Источник Form Explorer."
    },
    {
      "key": "kotTestToolkit.platforms.catalog",
      "label": "Установленные платформы 1С",
      "section": "infobases",
      "advanced": false,
      "type": "array",
      "default": [],
      "description": "Каталог доступных платформ 1С, которые использует KOT при запуске.\n\nКаждый элемент должен содержать `name` и `clientExePath` с путем к `1cv8c.exe`.\n\nПервая запись в списке считается платформой по умолчанию. KOT автоматически заполняет каталог найденными установленными платформами; сначала идет самая свежая обнаруженная версия.\n\n[Открыть менеджер платформ](command:kotTestToolkit.managePlatforms)",
      "preferredScope": "user",
      "editor": "manager",
      "hint": "Каталог доступных платформ 1С, которые использует KOT при запуске."
    },
    {
      "key": "kotTestToolkit.platforms.promptForLaunches",
      "label": "Спрашивать платформу перед запуском",
      "section": "infobases",
      "advanced": false,
      "type": "boolean",
      "default": true,
      "description": "Спрашивать, какую платформу 1С использовать при запуске баз, Form Explorer и встроенного запуска Vanessa. Если выключено, KOT всегда использует платформу по умолчанию.",
      "preferredScope": "user",
      "hint": "Спрашивать, какую платформу 1С использовать при запуске баз, Form Explorer и встроенного запуска Vanessa."
    },
    {
      "key": "kotTestToolkit.infobaseManager.templateDirectories",
      "label": "Дополнительные каталоги шаблонов 1С",
      "section": "infobases",
      "advanced": true,
      "type": "array",
      "default": [],
      "description": "Дополнительные каталоги установленных шаблонов 1С (tmplts). KOT читает файлы 1cv8.mft: .cf для пустой базы и обновления конфигурации, .dt для демо-базы. Автоматически учитываются ConfigurationTemplatesLocation из 1CEStart.cfg и стандартный каталог шаблонов. Пути обычно задаются в Пользовательских настройках.",
      "preferredScope": "user",
      "hint": "Дополнительные каталоги установленных шаблонов 1С (tmplts).",
      "pathKind": "directories",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.ai.apiFormat",
      "label": "Тип AI-сервиса",
      "section": "ai",
      "advanced": false,
      "type": "string",
      "default": "chatCompletions",
      "description": "Формат HTTP API, через который расширение обращается к подключенной LLM.",
      "preferredScope": "user",
      "enum": [
        "responses",
        "chatCompletions"
      ],
      "hint": "Формат HTTP API, через который расширение обращается к подключенной LLM.",
      "optionLabels": [
        "OpenAI Responses API (`/responses`). Обычно предпочтителен для облачных моделей OpenAI.",
        "OpenAI-compatible Chat Completions API (`/chat/completions`). Лучший дефолт для локальных провайдеров и прокси."
      ]
    },
    {
      "key": "kotTestToolkit.ai.baseUrl",
      "label": "Адрес AI-сервиса",
      "section": "ai",
      "advanced": false,
      "type": "string",
      "default": "http://localhost:1234/v1",
      "description": "Базовый URL подключенной LLM.\n\nПримеры для локальных серверов:\n- `http://localhost:11434/v1`\n- `http://127.0.0.1:1234/v1`\n\nПримеры для облачных провайдеров:\n- `https://api.openai.com/v1`\n- `https://generativelanguage.googleapis.com/v1beta/openai`",
      "preferredScope": "user",
      "hint": "Базовый URL подключенной LLM."
    },
    {
      "key": "kotTestToolkit.ai.apiVersion",
      "label": "Версия API сервиса",
      "section": "ai",
      "advanced": true,
      "type": "string",
      "default": "",
      "description": "Версия API, добавляемая как `?api-version=...` к каждому URL запроса. Обязательна для Azure OpenAI.\n\nПримеры:\n- Chat Completions: `2024-12-01-preview`\n- Responses API: `2025-04-01-preview`\n\nДля стандартного OpenAI и локальных провайдеров оставьте пустым.",
      "preferredScope": "user",
      "hint": "Версия API, добавляемая как `?api-version=...` к каждому URL запроса."
    },
    {
      "key": "kotTestToolkit.ai.apiKey",
      "label": "Ключ доступа к AI-сервису",
      "section": "ai",
      "advanced": false,
      "type": "string",
      "default": "local",
      "description": "API-ключ подключенной LLM.\n\nЗначение хранится в `settings.json` в открытом виде, поэтому по возможности используйте отдельный ключ с минимально необходимыми правами. Для локальных провайдеров, которые не проверяют авторизацию, достаточно любого непустого значения, например `local`.",
      "preferredScope": "user",
      "editor": "password",
      "hint": "Ключ вашего AI-сервиса. Для него выберите область «Этот компьютер»."
    },
    {
      "key": "kotTestToolkit.ai.model",
      "label": "Модель",
      "section": "ai",
      "advanced": false,
      "type": "string",
      "default": "qwen3:4b",
      "description": "Имя модели для генерации описаний сценариев.\n\nПо умолчанию задано имя легкой локальной модели для Ollama-совместимого сценария: `qwen3:4b`. При необходимости замените на точный id модели, который доступен у вашего локального или облачного провайдера.",
      "preferredScope": "user",
      "hint": "Имя модели для генерации описаний сценариев."
    },
    {
      "key": "kotTestToolkit.ai.outputLanguage",
      "label": "Язык ответов AI",
      "section": "ai",
      "advanced": false,
      "type": "string",
      "default": "ru",
      "description": "Язык, на котором генерируется описание сценария.",
      "preferredScope": "user",
      "enum": [
        "ru",
        "en"
      ],
      "hint": "Язык, на котором генерируется описание сценария.",
      "optionLabels": [
        "Русский (`ru`)",
        "Английский (`en`)"
      ]
    },
    {
      "key": "kotTestToolkit.ai.maxLineLength",
      "label": "Длина строк в AI-описаниях",
      "section": "ai",
      "advanced": true,
      "type": "number",
      "default": 100,
      "description": "Максимальная видимая длина строки для сгенерированного описания с учетом YAML-отступа.",
      "preferredScope": "user",
      "hint": "Максимальная видимая длина строки для сгенерированного описания с учетом YAML-отступа."
    },
    {
      "key": "kotTestToolkit.ai.timeoutSeconds",
      "label": "Время ожидания ответа AI",
      "section": "ai",
      "advanced": true,
      "type": "number",
      "default": 180,
      "description": "Таймаут AI-запроса на генерацию описания в секундах.",
      "preferredScope": "user",
      "hint": "Таймаут AI-запроса на генерацию описания в секундах."
    },
    {
      "key": "kotTestToolkit.ai.systemPrompt",
      "label": "Дополнительные указания для AI",
      "section": "ai",
      "advanced": true,
      "type": "string",
      "default": "",
      "description": "Необязательная замена встроенного system prompt, который расширение использует при генерации описания сценария в метаданных KOT.\n\nОставьте пустым, чтобы использовать встроенный prompt, заточенный под YAML-сценарии KOT/1C.",
      "preferredScope": "user",
      "hint": "Необязательная замена встроенного system prompt, который расширение использует при генерации описания сценария в метаданных KOT."
    },
    {
      "key": "kotTestToolkit.startupParams.parameters",
      "label": "Общие ключи запуска 1С",
      "section": "infobases",
      "advanced": true,
      "type": "string",
      "default": "/L ru /DisableStartupMessages /DisableStartupDialogs",
      "description": "Параметры запуска 1С:Предприятие (разделенные пробелами, например, '/L ru /DisableStartupMessages /Debug')",
      "preferredScope": "user",
      "editor": "manager",
      "hint": "Параметры запуска 1С:Предприятие (разделенные пробелами, например, '/L ru /DisableStartupMessages /Debug')."
    },
    {
      "key": "kotTestToolkit.runtime.directory",
      "label": "Служебная папка KOT",
      "section": "advanced",
      "advanced": false,
      "type": "string",
      "default": ".vscode/kot-runtime",
      "description": "Путь к служебной runtime-папке KOT для yaml_parameters.json, логов и временных артефактов сборки. Это не то же самое, что СППР FeatureFolder.",
      "preferredScope": "folder",
      "hint": "Путь к служебной runtime-папке KOT для yaml_parameters.json, логов и временных артефактов сборки.",
      "pathKind": "directory",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.paths.fileWorkshopExe",
      "label": "Программа 1С для работы с файлами",
      "section": "advanced",
      "advanced": false,
      "type": "string",
      "default": "C:\\Program Files (x86)\\1cv8fv\\bin\\1cv8fv.exe",
      "description": "Полный путь к '1С:Предприятие — работа с файлами' (1cv8fv.exe).",
      "preferredScope": "user",
      "hint": "Полный путь к '1С:Предприятие — работа с файлами' (1cv8fv.exe).",
      "pathKind": "exe",
      "pathPolicy": "absolute"
    },
    {
      "key": "kotTestToolkit.paths.firstLaunchFolder",
      "label": "Инструменты начальной подготовки 1cDrive",
      "section": "advanced",
      "advanced": true,
      "type": "string",
      "default": "",
      "description": "Относительный путь к папке набора данных первого запуска (кнопка сборки архива первого запуска показывается только если папка существует)",
      "preferredScope": "user",
      "hint": "Относительный путь к папке набора данных первого запуска (кнопка сборки архива первого запуска показывается только если папка существует).",
      "pathKind": "directory",
      "pathPolicy": "relative"
    },
    {
      "key": "kotTestToolkit.legacy.enableDisabledTestsDirectoryMoveOnBuild",
      "label": "Исключать выключенные тесты переносом файлов",
      "section": "build",
      "advanced": true,
      "type": "boolean",
      "default": false,
      "description": "Легаси-режим: при Build tests временно переносить test/*.yaml выключенных сценариев во временную папку ОС и возвращать их после сборки.",
      "preferredScope": "folder",
      "hint": "Режим совместимости: перед компиляцией временно убирает настройки запуска выключенных тестов test/*.yaml, затем возвращает их. Обычно выключен; включайте только для старого рабочего процесса, которому нужен такой перенос.",
      "compatibility": true
    }
  ]
};
