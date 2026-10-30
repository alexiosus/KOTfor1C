# UI, Debug clients and SPPR follow-up Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans for owned tasks and dispatch independent UI fixes through superpowers:dispatching-parallel-agents. Preserve the existing checkout.

**Goal:** Исправить 15 уточнений пользователя, добавить сохранённые клиенты ручной отладки, завершить доступные пункты аудита СППР и затем спланировать управление Vanessa.

**Architecture:** Изменять существующие VS Code webviews и модели. Группы остаются личными по порядку, содержимое — общим по Git. Ручная отладка получает отдельный runtime overlay, исходный launch JSON не меняется. Preflight СППР читает исходники без автоматической перезаписи; явно заполнить defaults можно из Properties.

**Tech Stack:** TypeScript, Node tests, существующие VS Code API/webviews, YAML AST, SecretStorage. Без новых зависимостей.

**Spec:** Сообщение пользователя 2026-10-15, [аудит СППР](../audits/2026-10-14-compiler-support.md), [исследование Vanessa](../audits/2026-10-14-vanessa-debug-control.md).

## Global Constraints

- Сохранить все ранее авторизованные изменения. Не коммитить, не устанавливать расширение, не менять внешнюю обработку и корпус Drive.
- Сначала закончить UI и Debug, после них — реализацию продолжения СППР, затем только план live управления Vanessa.
- Поля SELECT остаются нативными, без фейда и прокрутки; допустимо многоточие. Левый фейд в остальных полях появляется только после начала прокрутки.
- Pin/Fold рядом с Save; тип и статус в одной строке под именем с разделителем. Open/Copy path и Files toolbar с подписями и одинаковым выравниванием.
- Pin сохраняет явное закрепление; без Pin страницы менеджеров очищают Properties. Фокус боковой панели сохраняет текущий тест.
- Личный порядок групп никогда не записывается в groups.yml. Общий порядок элементов сохраняется в соседних *.kot.yml. Метаданные не требуют полного пересканирования YAML.
- Секреты клиентов не попадают в workspaceState, Git, webview или журнал. Debug overlay отключает автоматический запуск/закрытие и сохраняет оригинальные артефакты.
- Ограничения process route предоставленного компилятора не подменять несуществующей нативной возможностью: исключения тегов, defaults и перебор значений диагностировать явно.

## Review Focus

- Страницы без snapshot/выбранной базы, ширины 420/880/1280px и стандартные 20px body padding VS Code.
- Изменённые источники/метаданные при drag, одинаковые ID в разных корнях, частичная ошибка записи и восстановление.
- Переключение редактора при ожидающем изменении Properties и незавершённых file transfers.
- Пароль внутри Srvr/File connection и дополнительных /P keys; отключение сохранённого набора и отмена мастера.
- Пустой явный override, табличный default, больше 100 вариантов и неверные типы build options.

## Task 1: Properties, old managers and reorder

**Files:** media/scenarioProperties.*, src/scenarioPropertiesPanel.ts, media/{infobaseManager,formExplorer,yamlParameters,kotWebviewText}.*, соответствующие native panel modules; phaseSwitcher/Library ordering and context modules.

**Interfaces:** Properties follow принимает активную вкладку webview отдельно от activeTextEditor. Provider.refreshProjectLibraryMetadata() обновляет только проекцию групп/порядка. Open properties использует существующую kotTestToolkit.openScenarioEditor с точным source URI.

- [x] Зафиксировать regression cases для подписей/строк header, native SELECT, очистки Properties при webview.
- [x] Вернуть все кнопки действий баз, убрать лишние сведения из списка, исправить ширину пути и статусы деталей.
- [x] Проверить Form Explorer без snapshot и с реальными synthetic snapshots; компактные empty states, полная ширина.
- [x] Скрывать SPPR inspector на других вкладках; выбирать профиль без повторной генерации артефактов и полного пересоздания UI.
- [x] Убрать место под gripper, не сохранять его после mouse focus; перестановка через метаданные с guarded commit/rollback без corpus scan.
- [x] Добавить Open properties в YAML context menus Test Manager и обеих Library.
- [x] Проверить targeted tests, types/lint и визуальный preview; удалить временные UI ресурсы.

## Task 2: Saved manual Debug clients

**Files:** новые vanessaDebugClients/clientConfiguration modules и tests, manual debug launch functions phaseSwitcher.ts, extension command и package contributions.

**Interfaces:** public configureVanessaDebugClients(); configure entry в Open Vanessa QuickPick и контекстном меню. Хранилище локального набора + SecretStorage; runtime overlay применяется только ручной отладке.

- [x] Проверить сохранение/повторное использование 1+ клиентов, базы из менеджера и custom file/server, необязательные user/password, cancel/disable.
- [x] Проверить RU/EN JSON, case/duplicate aliases, source JSON immutability, отсутствие секретов в state и log.
- [x] Проверить общий Debug, compiled-test и standalone Debug; приватные runtime артефакты и уборку после сеанса.
- [x] Локализовать команды/мастер и выполнить focused launch/storage tests.

## Task 3: SPPR audit completion — after Tasks 1–2

**Files:** новый compilerBuildPreflight.ts/tests, существующие compilerBuildParameters/runtime/phase integration, Properties model/session/media/action protocol, документация аудита.

**Interfaces:** pure collectCompilerBuildPreflightIssues(parameters, sources) возвращает {code, severity, message, uri?, parameter?}; причины ограничений process route — warnings, неверные build values/невалидный выбранный YAML/лимит вариантов — errors. Source inputs {uri, text} берутся из свежего snapshot перед запуском внешней обработки.

- [x] Добавить typed validation numeric/boolean/DetectionTime на основе реально читаемых полей BSL; валидные значения и aliases не переписывать.
- [x] До побочных действий сборки проверять выбранные настройки и source graph: лимит 100, несовместимый формат, process defaults/списки/ExceptionTags/Выключена.
- [x] В выбранной настройке процесса добавить явное действие заполнения отсутствующих defaults из ПараметрыСценария. Существующие значения, включая явную пустую строку, сохраняются; Таблица сохраняется многострочно.
- [x] Уточнить descriptions build options и документировать raw-scalar legacy types, optional reporting fields, Drive-specific SplitFeatureFiles; не создавать отсутствующие compiler enums.
- [x] Проверить pure и native integration tests на synthetic fixtures без исполнения EPF/внешних записей. Сверить каждый audit finding с реализацией или явной внешней границей.

## Task 4: Vanessa live control plan — after SPPR

**Files:** docs/superpowers/specs/2026-10-15-vanessa-control-design.md и docs/superpowers/plans/2026-10-15-vanessa-control.md.

- [x] Сверить текущие первичные docs/tools registry; явные capabilities/version prerequisites, endpoint/attach.
- [x] Спланировать from-line/one-step/stop/state, then breakpoint synchronization, then YAML .str mapping; согласованная семантика continue/циклов.
- [x] Учесть local credentials/endpoint trust, отмену/выбор активного сеанса, устаревшие build maps и отсутствие инструмента pause/step-over.
- [x] Не реализовывать MCP на этом этапе: пользователь просит последующий план.

## Task 5: Final verification

- [x] Проверить все пользовательские пункты и изменения агентов; npm run vscode:prepublish и git diff --check.
- [x] Зафиксировать полный test count и границу: EPF/живое исполнение 1С не проверялось.

## Проверка завершения — 2026-10-15

- `npm run vscode:prepublish`: exit 0; **1765 tests, 1763 passed, 0 failed, 2 skipped**, type checks, ESLint и minified bundle.
- `git diff --check` и syntax checks изменённых webview JS: exit 0.
- Code review обнаружил потерю дубликата UID выключенного двойника корня: исправлено, добавлен regression для отбора источников и preflight.
- Визуально проверены Properties и старые панели в локальных browser previews; screenshot Properties: `/private/tmp/kot-properties-20261015.png`. Preview-серверы и вкладки закрыты.
- EPF/1С и live MCP не запускались. Внешние исходники и корпус Drive не изменялись. Следующий план Vanessa подготовлен; MCP implementation не включён в текущие изменения.
