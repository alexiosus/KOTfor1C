# Блок: KOT Form Explorer (beta)

## Что это

`KOT Form Explorer` — beta-функционал для исследования живой управляемой формы 1С прямо из VS Code.

Он состоит из двух частей:

1. webview-панель в VS Code;
2. bridge-сессия на стороне 1С, которая запускает рабочую базу в `TestClient`, служебную startup-ИБ в `TestManager` и пишет snapshot активной формы в JSON.

Результат:

- можно увидеть структуру текущей формы, активный элемент и значения полей;
- быстро перейти к `Form.xml`;
- переключать режимы `manual` / `auto`;
- искать активный элемент через `Locator`;
- читать snapshot по одному настроенному `snapshotPath`, при этом KOT сам находит актуальный runtime-файл;
- использовать тот же snapshot в редакторе для IntelliSense по атрибутам формы и аргументам шагов.

## Архитектура

Form Explorer построен как гибрид:

- **bridge-слой** получает живое состояние формы через `TestClient`;
- **static-слой** читает выгрузку `cf` и обогащает snapshot данными из `Form.xml` и metadata;
- **VS Code webview** объединяет эти данные в один инспектор.

### Что делает bridge

Bridge:

- запускает целевую базу в `TestClient`;
- запускает служебную startup-ИБ в `TestManager` с `KOTFormExplorerBridge.epf`;
- каждую секунду опрашивает активное окно и активную форму;
- пишет `form-snapshot.json`;
- читает request-файл для команд `auto`, `manual`, `refresh`, `table`, `locator`.

### Что делает VS Code

Панель:

- читает `form-snapshot.json`;
- читает `adapter-mode.txt`;
- при клике на индикатор режима пишет `adapter-mode-request.txt`;
- обогащает runtime-данные через `Form.xml`;
- умеет открыть snapshot-файл и исходный `Form.xml`;
- блокирует повторный `Start infobase`, пока активна текущая bridge-сессия;
- отдает live snapshot редактору, чтобы подсказки шагов и ссылок на атрибуты формы использовали актуальное состояние текущего окна.

## Что нужно на стороне проекта

Минимум:

- доступ к базе, которую можно открыть в `TestClient`;
- настроенный путь `kotTestToolkit.formExplorer.snapshotPath`;
- выгрузка конфигурации в файловом формате в `kotTestToolkit.formExplorer.configurationSourceDirectory`, если нужен static enrichment и переходы к `Form.xml`.

Основную конфигурацию менять не нужно.

## Команды VS Code

- `KOT - Open 1C Form Explorer`
- `KOT - Start Form Explorer Bridge (TestClient mode)`

Legacy compatibility-команды:

- `KOT - Generate Form Explorer extension project`
- `KOT - Build Form Explorer .cfe`
- `KOT - Install Form Explorer extension into infobase`

## Настройки VS Code

| Настройка | Назначение |
|---|---|
| `kotTestToolkit.formExplorer.snapshotPath` | Путь к `form-snapshot.json` |
| `kotTestToolkit.formExplorer.configurationSourceDirectory` | Каталог исходников конфигурации 1С для static enrichment |
| `kotTestToolkit.formExplorer.generatedArtifactsDirectory` | Каталог runtime-артефактов Form Explorer |
| `kotTestToolkit.formExplorer.extensionBuildCommandTemplate` | Legacy override внешней сборки `.cfe` для compatibility/internal сценариев |
| `kotTestToolkit.formExplorer.autoRefreshSeconds` | Интервал перечитывания snapshot-а в webview |
| `kotTestToolkit.formExplorer.showOutputPanel` | Автопоказ Output при подготовке и запуске bridge-сессии |
| `kotTestToolkit.formExplorer.bridge.testClientPort` | Порт связи между `TestManager` и `TestClient` |
| `kotTestToolkit.platforms.catalog` | Каталог платформ 1С для запуска Form Explorer |
| `kotTestToolkit.platforms.promptForLaunches` | Спрашивать платформу при запуске Form Explorer |

Рекомендуемые значения по умолчанию:

```text
snapshotPath = .vscode/kot-runtime/form-explorer/form-snapshot.json
configurationSourceDirectory = cf
generatedArtifactsDirectory = .vscode/kot-runtime/form-explorer
```

## Legacy compatibility path (`.cfe`)

`.cfe` / install-ветка все еще присутствует в расширении, но рассматривается как legacy-режим.

## One-click flow

### 1. Открыть KOT Form Explorer

Панель `Test Manager` -> `...` -> `Open KOT Form Explorer` или команда `KOT - Open 1C Form Explorer`.

### 2. Запустить базу для отслеживания

1. В панели нажать `Start infobase`;
2. Выбрать существующую файловую или серверную базу;
3. При необходимости указать логин/пароль базы;
4. Выбрать платформу 1С, если включен `promptForLaunches`;
5. Дождаться старта двух окон:
   - рабочей базы в `TestClient`;
   - окна моста в служебной startup-ИБ `TestManager`.

### 3. Начать пользоваться исследователем формы

После появления snapshot-а список элементов наполнится по текущей открытой форме.

Дальше можно:

- переключать `manual` / `auto`;
- делать `Refresh`;
- использовать `Locator`;
- читать табличные части прямо в snapshot;
- переходить к исходному `Form.xml`.

Альтернативно старт можно сделать из `KOT Infobase Manager` кнопкой `Start Form Explorer` у выбранной базы.

## Режимы обновления

### Manual

Snapshot обновляется только по явному действию:

- `Refresh` в VS Code;
- `Locator`;
- отдельный запрос состояния табличной части;
- переключение режима.

### Auto

Bridge периодически проверяет активную форму и обновляет snapshot автоматически.

Чтобы не переписывать файл без надобности, bridge сравнивает новый snapshot с предыдущим и сохраняет файл только если данные реально изменились.

## Переключение режима из VS Code

В шапке панели есть индикатор `Update mode`.

Схема работы:

1. VS Code пишет запрос в `adapter-mode-request.txt`;
2. bridge читает request-файл;
3. bridge применяет новый режим;
4. фактическое состояние подтверждается через `adapter-mode.txt`.

Это простой файловый handshake между панелью и EPF-мостом.

## Файлы runtime

В `generatedArtifactsDirectory` используются:

| Файл | Назначение |
|---|---|
| `form-snapshot.json` | Последний snapshot формы |
| `adapter-mode.txt` | Фактический режим (`manual` / `auto`) |
| `adapter-mode-request.txt` | Запрос от VS Code на переключение режима |
| `adapter-request-context.json` | Контекст последнего запроса (`refresh`, `table`, `locator`, `mode`) |
| `bridge/bridge-config.json` | Конфигурация bridge-сессии |
| `bridge/bridge-status.txt` | Технический статус работы моста |
| `forms-index.json` | Статический индекс управляемых форм |

## Что показывает панель

### Elements

Реальные UI-контролы формы:

- поля;
- кнопки;
- табличные части;
- группы;
- декоративные элементы и контейнеры.

Это основной рабочий слой.

Именно эти данные используются и в редакторе, когда нужно подставить имя поля, кнопки, таблицы, колонки или текущее значение элемента в аргументы шага.

### Form attributes

_По умолчанию скрыто. Чтобы показать, включите `Technical info` в меню `...`._

Это данные формы, на которые ссылаются UI-элементы.

### Commands

_По умолчанию скрыто. Чтобы показать, включите `Technical info` в меню `...`._

Это действия формы, доступные в текущем snapshot-е.

## Формат snapshot-а

Минимальный контракт:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-04-21T12:34:56",
  "source": {
    "infobase": "File=/path/to/base",
    "sessionId": "TestClientBridge"
  },
  "form": {
    "title": "Document",
    "windowTitle": "Document 123",
    "name": "DocumentForm",
    "metadataPath": "",
    "type": "ManagedForm",
    "activeElementPath": "Items.Counterparty"
  },
  "elements": [],
  "tables": [],
  "attributes": [],
  "commands": []
}
```

## Ограничения

- Полноценно сценарий проверен в основном на Windows.
- Bridge зависит от `TestClient`, поэтому web-базы не поддерживаются.
- Не все конфигурации одинаково хорошо отдают живые значения и структуру сложных форм.
- Если менялся BSL source моста, нужно пересобрать `KOTFormExplorerBridge.epf`.
