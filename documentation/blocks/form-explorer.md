# Блок: KOT Form Explorer (beta)

## Что это

`KOT Form Explorer` — beta-функционал, который состоит из двух частей:

1. webview-панель в VS Code, которая показывает текущую управляемую форму 1С;
2. lightweight runtime-расширение `.cfe`, которое ставится в тестовую базу и пишет snapshot открытой формы в файл.

Результат:

- можно открыть текущую форму прямо в VS Code;
- увидеть активный элемент, UI-имя, technical name, значение и связанные атрибуты;
- быстро перейти к `Form.xml` на строку элемента;
- включать `manual` / `auto` режим обновления;
- искать элемент по клику в интерфейсе 1С.

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

### Что делает VS Code

Панель:

- читает `form-snapshot.json`;
- читает `adapter-mode.txt`;
- при клике на индикатор режима пишет `adapter-mode-request.txt`;
- сопоставляет runtime-элементы с `Form.xml`;
- показывает список UI-элементов, selected element, form attributes и commands.

## Что нужно на стороне проекта

Минимум:

- возможность установить `.cfe` в тестовую базу;
- исходники конфигурации в файловом формате в `kotTestToolkit.formExplorer.configurationSourceDirectory` - они используются для генерации адаптера и static enrichment.

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

### 1. Открыть KOT Form Explorer

Панель `Test Manager` -> `...` -> `Open KOT Form Explorer` или команда `KOT - Open 1C Form Explorer`.

### 2. Запустить базу для отслеживания

1. В открывшемся окне нажать `Start infobase`;
2. Выбрать базу из предложенных или ввести путь вручную;
3. (_Если требуется_) Ввести имя пользователя базы и пароль;
4. (_Если процесс уже был пройден раньше_) Будет запрос - запустить базу как есть, или переустановить расширение. Рекомендуется переустановить, если были внесены изменения в `configurationSourceDirectory` или в код самого адаптера.;

_В этот момент происходит сборка адаптера по файловой выгрузке из `configurationSourceDirectory` и установка этого `.cfe` в выбранную базу. Конфигурация самой выбранной базы сейчас не используется как источник сборки._

5. Дождаться открытия базы.


### 3. Начать пользоваться исследователем формы

В выпадающем списке Snapshots в шапке интерфейса должна автоматически появиться текущая открытая база, а список элементов должен наполниться по текущей открытой форме (стартовой странице 1С).

## Настройки адаптера в 1С

Расширение конфигурации (адаптер) создает свою подсистему. В ней есть команда `KOT Form Explorer settings`.

Там настраиваются:

- `Snapshot path` - кастомный путь до файла состояния формы;
- `Hotkey preset` - комбинация клавиш для ручного снятия состояния формы, находясь в окне 1С (опциональный вариант, так как обновление можно запрашивать из интерфейса VSCode);
- `Auto snapshot` - режим снятия состояния формы. Переключается либо тут, либо в интерфейсе VSCode;
- `Interval` - интервал автообновления снятия состояния формы.

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
- ручной refresh в VSCode;
- поиск элемента по клику из VSCode (локатор);
- отдельный запрос состояния табличной части по кнопке.

### Auto

Адаптер периодически проверяет форму и записывает snapshot автоматически.

Чтобы случайно не подвешивать клиент на каждом тике, auto-режим получает:

- текущая форма;
- активный элемент;
- значения элементов;
- без табличных частей (как в manual режиме, они запрашиваются отдельно).

Полный snapshot строится только если форма изменилась.

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
| `builder-infobase/` | Кэшированная builder-ИБ для встроенной сборки вне выбранной базы (на основании конфигурации репозитория) |
| `builder-base-state.json` | Stamp состояния основной конфигурации |

## Встроенная сборка и сохранения .cfe адаптера

1. создается файловая builder-ИБ или переиспользуется существующая;
2. основная конфигурация загружается туда только при изменении `Configuration.xml`;
3. generated extension загружается через `-Extension`;
4. `.cfe` выгружается через `DumpCfg -Extension`.

Это сильно ускоряет повторные сборки.

При запуске базы через `Start infobase` используется тот же источник сборки: `configurationSourceDirectory`. Выбранная база служит местом установки адаптера и последующего запуска клиента 1С, а ускорение повторных сборок достигается за счет кэшированной builder-ИБ.

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

_По умолчанию скрыто, чтобы показать, надо включить Technical info в меню `...`_

`Form attributes` — это данные формы, на которые ссылаются UI-элементы:

- `Object.Counterparty`
- `Object.BasisDocument`
- временные реквизиты формы
- вычисляемые атрибуты

Этот блок полезен как диагностический слой, а не как основной navigator.

### Commands

_По умолчанию скрыто, чтобы показать, надо включить Technical info в меню `...`_

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
  "tables": [],
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
- `tableData` (for table/list controls; includes `columns`, `rows`, `rowCount`, `truncated`)
- `active`
- `visible`
- `enabled`
- `available`
- `readOnly`
- `metadataPath`
- `source`
- `children`

### Поддерживаемые ключевые поля snapshot

- `tables` (optional list of detected form tabular sources; each item may contain `path`, `title`, `elementPath`, `boundAttributePath`, `sourcePath`, `tableData`)

## Ограничения

- Решение рассчитано на управляемые формы.
- На данный момент не вычисляются `DynamicList` списки.
- Часть форм может требовать дополнительных fallback-ов.
- После изменений в webview расширения достаточно перезагрузить окно VS Code.
- После изменений в адаптере всегда нужно пересобрать и переустановить `.cfe`.
- Процесс проверялся только на Windows.

## Где смотреть дальше

- [`README.md`](../../README.md)
- [`documentation/DEVELOPMENT.md`](../DEVELOPMENT.md)
