# Блок: Build and Vanessa Run

## Задача блока

Из набора YAML-сценариев получить готовые артефакты (`.feature` + `.json`) и запустить их в Vanessa Automation.

## Сборка

### Что делает сборка

- Читает выбранные в Test Manager (`Менеджер тестов`) главные сценарии.
- По выбранным чекбоксам автоматически формирует `Exceptscenario` или `Scenariofilter`.
- Запускает `СборкаТекстовСценариев.epf`.
- Генерирует `.feature` и `.json` артефакты для запуска.
- Показывает уведомления о результате и дает быстрые действия (открыть файл/папку).

### Важные действия в UI

- `Build tests` (`Собрать тесты`)
- `Cancel build` (`Отменить сборку`)
- `Open feature file(s)` / `Open folder` (`Открыть feature-файл(ы)` / `Открыть папку`) после сборки

## Запуск Vanessa

### Способы запуска

1. Иконка запуска рядом со сценарием (обычный прогон).
2. Верхняя кнопка запуска в Test Manager (`Менеджер тестов`) (выбор режима):
   - автоматический прогон (через выбор сценария);
   - запуск Vanessa для ручной отладки (без автопрогона сценария).

### Статусы запуска

- `running`
- `passed`
- `failed`
- `stale`

### Логи

- Отдельный run-лог на сценарий.
- `Open run log` (`Открыть лог запуска`) открывает файл run-лога в редакторе.
- Live-режим для сценария открывает `feature` на текущем выполняемом шаге (вместо принудительного открытия Output).
- Output панель не открывается автоматически при старте прогона.
- При падении в уведомлении и hover доступны быстрые действия для run-лога.

### Подсветка и переходы по шагам в `feature`

- Во время выполнения шага:
  - текущая строка шага подсвечивается;
  - пройденные строки подсвечиваются зеленым;
  - при ошибке строка шага подсвечивается красным.
- Есть автосопровождение текущего шага с временной разблокировкой при ручной прокрутке.
- Для упавшего шага в hover доступны действия:
  - `Open run log`;
  - `Open failed nested scenario`.
- Подсветка шага сохраняется до изменения `feature`-файла или до пересборки артефактов.

## Настройки блока

| Настройка | Назначение |
|---|---|
| `kotTestToolkit.paths.oneCEnterpriseExe` | Исполняемый файл 1С |
| `kotTestToolkit.paths.emptyInfobase` | Пустая ИБ для запуска |
| `kotTestToolkit.paths.buildScenarioBddEpf` | EPF обработки сборки |
| `kotTestToolkit.runVanessa.vanessaEpfPath` | EPF Vanessa |
| `kotTestToolkit.assembleScript.buildPath` | Папка сборки |
| `kotTestToolkit.runVanessa.runtimeDirectory` | Папка runtime-логов/статусов |
| `kotTestToolkit.startupParams.parameters` | Параметры старта 1С |
| `kotTestToolkit.runVanessa.liveLogRefreshSeconds` | Интервал live-обновления лога |
| `kotTestToolkit.runVanessa.checkUnsafeActionProtection` | Проверка conf.cfg перед запуском (Windows) |
| `kotTestToolkit.runVanessa.commandTemplate` | Кастомный шаблон запуска Vanessa |

## commandTemplate: когда использовать

Используйте `runVanessa.commandTemplate`, если нужно:

- полностью контролировать командную строку запуска;
- встроиться в корпоративный launch-скрипт;
- добавить специфичные флаги/обвязку процесса.

Плейсхолдеры:

- `${scenarioName}`: имя запускаемого сценария (из `ДанныеСценария.Имя` выбранного теста).
- `${scenarioNameQuoted}`: имя сценария в quoted-виде для shell.
- `${featurePath}`: абсолютный путь к `.feature` выбранного сценария из результатов последней сборки.
- `${featurePathQuoted}`: путь к `.feature` в quoted-виде для shell.
- `${jsonPath}`: абсолютный путь к `.json` выбранного сценария. Может стать временным overlay JSON при добавлении runtime VA-параметров.
- `${jsonPathQuoted}`: путь к `.json` в quoted-виде для shell.
- `${workspaceRoot}`: абсолютный путь к корню открытого проекта в VS Code.
- `${workspaceRootQuoted}`: путь к корню проекта в quoted-виде для shell.

Если шаблон пустой, используется built-in launcher расширения.
