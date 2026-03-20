# Блок: KOT Form Explorer (beta)

## Что это

`KOT Form Explorer` — beta-функционал, который состоит из двух частей:

1. webview-панель в VS Code, которая показывает текущую управляемую форму 1С;
2. lightweight runtime-расширение `.cfe`, которое ставится в тестовую базу и пишет snapshot открытой формы в файл.

Результат:

- можно открыть текущую форму прямо в VS Code;
- увидеть активный элемент, UI-имя, technical name, значение и связанные атрибуты;
- быстро перейти к `Form.xml` на строку элемента;
- включать `manual` / `auto` режим обновления без правок основной конфигурации.

## Финальная архитектура

Решение построено как гибрид:

- **runtime-слой** снимает snapshot живой формы из клиентской сессии 1С;
- **static-слой** парсит выгрузку `cf` и обогащает snapshot данными из `Form.xml` и metadata;
- **VS Code webview** объединяет оба источника и показывает нормальный inspector.

### Что делает runtime `.cfe`

Сгенерированное расширение:

- не заимствует прикладные формы;
- добавляет подсистему `KOT Form Explorer`;
- содержит общий клиентский модуль `KOTFormExplorerAdapterClient`;
- инициализируется на старте клиентской сессии через `ManagedApplicationModule`;
- умеет снимать snapshot вручную и автоматически;
- хранит локальные настройки адаптера рядом с generated artifacts;
- поддерживает `manual` / `auto` режим и переключение режима из 1С и из VS Code.
- использует собственную builder-ИБ, которая прогревается расширением VS Code автоматически.

### Что делает VS Code

Панель:

- читает `form-snapshot.json`;
- читает `adapter-mode.txt`;
- при клике на индикатор режима пишет `adapter-mode-request.txt`;
- сопоставляет runtime-элементы с `Form.xml`;
- показывает список UI-элементов, selected element, form attributes и commands.

## Что нужно на стороне проекта

Минимум:

- исходники конфигурации в файловом формате (`cf`);
- возможность установить `.cfe` в тестовую базу;
- путь для generated artifacts внутри workspace.

Основную конфигурацию менять не нужно.

## Команды VS Code

- `KOT - Open 1C Form Explorer`
- `KOT - Generate Form Explorer extension project`

## Настройки VS Code

| Настройка | Назначение |
|---|---|
| `kotTestToolkit.formExplorer.snapshotPath` | Путь к `form-snapshot.json` |
| `kotTestToolkit.formExplorer.configurationSourceDirectory` | Каталог исходников конфигурации 1С |
| `kotTestToolkit.formExplorer.generatedArtifactsDirectory` | Каталог generated artifacts |
| `kotTestToolkit.formExplorer.extensionOutputPath` | Путь к итоговому `.cfe` |
| `kotTestToolkit.formExplorer.extensionBuildCommandTemplate` | Необязательный override для внешней сборки `.cfe` |
| `kotTestToolkit.formExplorer.autoRefreshSeconds` | Интервал перечитывания snapshot-а в самой webview |
| `kotTestToolkit.formExplorer.showOutputPanel` | Автопоказ Output при сборке `.cfe` и подготовке builder-ИБ |
| `kotTestToolkit.paths.oneCEnterpriseExe` | Путь к `1cv8c.exe` тонкого клиента 1С; если пусто, KOT пытается определить его автоматически |

Рекомендуемые значения по умолчанию:

```text
snapshotPath = .vscode/kot-runtime/form-explorer/form-snapshot.json
configurationSourceDirectory = cf
generatedArtifactsDirectory = .vscode/kot-runtime/form-explorer
extensionOutputPath = .vscode/kot-runtime/form-explorer/KOTFormExplorerRuntime.cfe
```

## One-click flow

### 1. Сгенерировать runtime

Команда `KOT - Generate Form Explorer extension project` делает следующее:

1. сканирует `configurationSourceDirectory`;
2. строит `forms-index.json`;
3. генерирует source tree расширения в `generatedArtifactsDirectory/extension-src`;
4. инициализирует локальные sidecar-файлы адаптера;
5. собирает `.cfe`:
   - либо встроенным Windows builder через настроенный `1cv8c.exe` и соседний `1cv8.exe`,
   - либо внешней командой из `extensionBuildCommandTemplate`.

### 2. Установить `.cfe`

Установите собранный `KOTFormExplorerRuntime.cfe` в тестовую базу.

### 3. Перезапустить клиент 1С

После установки нужен полный перезапуск клиентской сессии, потому что startup-инициализация адаптера происходит в `ManagedApplicationModule`.

### 4. Открыть инспектор

1. В VS Code откройте `KOT - Open 1C Form Explorer`.
2. В 1С откройте нужную управляемую форму.
3. Работайте либо через hotkey ручного snapshot-а, либо в `auto` режиме.

## Настройки адаптера в 1С

В runtime-расширении есть команда `KOT Form Explorer settings`.

Там настраиваются:

- `Snapshot path`
- `Hotkey preset`
- `Auto snapshot`
- `Interval`

### Доступные preset-шорткаты

- `Ctrl+Shift+F12`
- `Ctrl+Alt+F12`
- `Alt+Shift+F12`
- `Ctrl+Shift+F11`
- `Disabled`

### Дополнительный hotkey

- `Ctrl+Alt+F11` — переключение `manual` / `auto`

## Режимы обновления

### Manual

Snapshot обновляется только по ручному действию:

- выбранный preset-hotkey;
- команда обновления из runtime;
- ручной refresh.

### Auto

Адаптер периодически проверяет форму и записывает snapshot автоматически.

Чтобы не подвешивать клиент на каждом тике, auto-режим использует cheap-signature:

- текущая форма;
- активный элемент;
- значение активного элемента.

Полный snapshot строится только если это действительно изменилось.

## Переключение режима из VS Code

В шапке панели есть индикатор `Update mode`.

Схема работы:

1. VS Code пишет запрос в `adapter-mode-request.txt`;
2. адаптер 1С читает request-файл;
3. применяет новый режим;
4. подтверждает фактическое состояние через `adapter-mode.txt`.

Такой handshake надежнее, чем запись обоими сторонами в один и тот же файл.

## Файлы runtime

В `generatedArtifactsDirectory` используются:

| Файл | Назначение |
|---|---|
| `form-snapshot.json` | Последний snapshot формы |
| `adapter-settings.json` | Локальные настройки адаптера |
| `adapter-mode.txt` | Фактический режим адаптера (`manual` / `auto`) |
| `adapter-mode-request.txt` | Запрос от VS Code на переключение режима |
| `forms-index.json` | Статический индекс управляемых форм |
| `extension-src/` | Сгенерированный source tree расширения |
| `builder-infobase/` | Кэшированная builder-ИБ для встроенной сборки |
| `builder-base-state.json` | Stamp состояния основной конфигурации |

## Встроенная Windows-сборка

Если `extensionBuildCommandTemplate` пустой и указан `kotTestToolkit.paths.oneCEnterpriseExe`, используется встроенный builder:

1. создается или переиспользуется файловая builder-ИБ;
2. основная конфигурация загружается туда только при изменении `Configuration.xml`;
3. generated extension загружается через `-Extension`;
4. `.cfe` выгружается через `DumpCfg -Extension`.

Это сильно ускоряет повторные сборки.

При старте расширения VS Code KOT пытается:

1. автоматически найти установленный `1cv8c.exe`;
2. записать найденный путь в настройки, если пользователь его еще не указал;
3. в фоне создать builder-ИБ Form Explorer, если она еще не существует.

### Внешний override

При необходимости можно заменить встроенный builder на внешний.

В репозитории есть готовые примеры:

- [`tools/form-explorer/build-cfe.ps1`](../../tools/form-explorer/build-cfe.ps1)
- [`tools/form-explorer/build-cfe.os`](../../tools/form-explorer/build-cfe.os)

Пример для `OneScript`:

```text
oscript ./tools/form-explorer/build-cfe.os --onec ${oneCExePathQuoted} --base-config-dir ${configurationSourceDirQuoted} --extension-src ${extensionSourceDirQuoted} --out ${cfePathQuoted} --work-dir ${generatedArtifactsDirQuoted}
```

## Что показывает панель

### Elements

`Elements` — это реальные UI-контролы формы:

- поля;
- кнопки;
- вкладки;
- группы;
- контейнеры.

Это основной рабочий слой.

### Form attributes

`Form attributes` — это данные формы, на которые ссылаются UI-элементы:

- `Object.Counterparty`
- `Object.BasisDocument`
- временные реквизиты формы
- вычисляемые атрибуты

Этот блок полезен как диагностический слой, а не как основной navigator.

### Commands

`Commands` — это действия формы, доступные в текущем snapshot-е.

Они нужны в основном для анализа поведения формы и привязанных действий.

## Формат snapshot-а

Минимальный контракт:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-03-20T10:15:00.000Z",
  "form": {
    "title": "Sales order 0000-000001 dated 5/5/2019",
    "windowTitle": "Sales order 0000-000001 dated 5/5/2019",
    "name": "DocumentForm",
    "metadataPath": "Document.SalesOrder.Form.DocumentForm",
    "type": "ManagedForm",
    "activeElementPath": "Client application form.Header.HeaderLeft.Counterparty"
  },
  "elements": [],
  "attributes": [],
  "commands": []
}
```

### Поддерживаемые ключевые поля элемента

- `path`
- `name`
- `title`
- `synonym`
- `kind`
- `type`
- `boundAttributePath`
- `valuePreview`
- `active`
- `visible`
- `enabled`
- `available`
- `readOnly`
- `metadataPath`
- `source`
- `children`

## Ограничения

- Решение рассчитано на управляемые формы.
- Значения и runtime-caption-ы собираются best-effort: часть форм может требовать дополнительных fallback-ов.
- Для изменений в webview достаточно перезагрузить окно VS Code.
- Для изменений в runtime adapter всегда нужно пересобрать и переустановить `.cfe`.
- Проверка builder pipeline и runtime в первую очередь ориентирована на Windows.

## Где смотреть дальше

- [`README.md`](../../README.md)
- [`documentation/DEVELOPMENT.md`](../DEVELOPMENT.md)
- [`res/formExplorer/adapter/KOTFormExplorerAdapterClient.bsl`](../../res/formExplorer/adapter/KOTFormExplorerAdapterClient.bsl)
- [`res/formExplorer/sample-form-snapshot.json`](../../res/formExplorer/sample-form-snapshot.json)
