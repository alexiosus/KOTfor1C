# Vanessa control Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Follow the compatibility gates before claiming live execution support. Preserve the existing checkout and saved Debug launch behavior.

**Goal:** Управлять совместимой запущенной Vanessa из VS Code: служебная ИБ с MCP, прямое состояние и ручные шаги/F11, breakpoints и YAML, затем клиенты, переменные, Form Explorer, запись действий и диагностика.

**Architecture:** MCP transport отдельно от state machine и VS Code UI. Выполнение, остановка и чтение состояния имеют разные очереди. Typed adapter изолирует Markdown внешний протокол. Встроенный компилятор и Debug launch не переписываются.

**Tech Stack:** TypeScript, VS Code commands/decorations, существующие native tests, официальный MCP SDK после проверки/фиксации поддержанной версии. Без LLM в рабочем runtime.

**Spec:** [Дизайн](../specs/2026-10-15-vanessa-control-design.md), [проверенные источники](../audits/2026-10-14-vanessa-debug-control.md#перепроверка-2026-10-15).

**Статус 2026-10-18:** Tasks 1–2 реализованы и проверены в Windows Extension Development Host: Vanessa `1.2.043.45`, devkit `0.6.6`, 48 tools, Ready. Для Tasks 3–4 подтверждены F11 с переходом на фактическую следующую строку, запуск с середины, Stop, ошибка, reconnect, gutter/list/toggle и остановка перед точкой. Проверены точка в цикле и повторный запуск. Автоматический обратный переход F11 в цикле некорректен в этом runtime и отключён; точка внутри экспортного вызова была пропущена Vanessa, этот gate остаётся открытым. Task 5: реализованы хеши входов/артефактов, манифест после сборки, точное сопоставление и индекс неизменяемых карт, YAML-команды F11/run/toggle с выбором вхождения и декорациями. Реальная сборка проверена на двух частях, вложенном процессе, повторных вызовах и двух сочетаниях параметров (8 вхождений одной строки). Контроллер YAML выполнил выбранный Delay и установил/удалил точку в живой Vanessa. Native picker/декорации VS Code ещё проверяются; mini-feature для обычного шага реализован отдельной командой, native-проверка продолжается. Tasks 6–7 впоследствии завершены; актуальное продолжение ниже. DT проверен восстановлением в чистой базе: client_mcp активен, SafeMode=false, защита от опасных действий включена. [Инструкция](../../../documentation/blocks/vanessa-control.md).

**Уточнение схемы 2026-10-17:** подготовка MCP интегрируется в существующую служебную ИБ KOT при управляемом запуске. Отдельный обязательный мастер/новая база не нужны; VAExtension не является общей предпосылкой управления менеджером. Автоматическая установка ограничена служебной ИБ KOT; внешнее подключение только проверяет доступность и capabilities.

## Constraints

- Реализованные и проверенные части отмечены ниже; открытые upstream-ограничения не считаются пройденными. Новые команды требуют подтверждённых tools/schema.
- Не запускать/менять производственные базы для проверки; live acceptance — в disposable окружении, выбранном пользователем.
- Автоматически подготавливать devkit и его транспорт только в служебной ИБ KOT для управляемого запуска. Внешние базы при Attach не изменять; отсутствие VAExtension не блокирует управление менеджером. Attach без endpoint выдаёт понятную причину.
- Не называть повторный запуск Continue и не предлагать BSL step-over без внешней capability.
- Без установки версии SDK по памяти: проверить официальную документацию и lockfile на этапе реализации.

## Task 1: Capability contract and transport

**Files:** src/vanessaControlProtocol.ts, src/vanessaControlTransport.ts, test/vanessaControlProtocol.test.ts, test/vanessaControlTransport.test.ts; package.json/lock только при выборе SDK.

**Interfaces:** `ControlTransport.initialize(endpoint, signal)`, `listTools()`, `callTool(name,args,signal)`, `dispose()`; normalized capability set и typed response union. Tool names/argument schema проверяются с сервером.

- [x] Добавить source-derived fixtures схем инструментов и Markdown state/breakpoints из проверенного релиза, без учётных данных. Это не живой capture; результаты выполнения до отдельной проверки остаются unknown.
- [x] Red tests: отсутствующая capability, изменённая schema, unknown Markdown, SSE disconnect, timeout, late response, cancel.
- [x] Реализовать initialize/negotiation/transport cleanup; неизвестный формат возвращает unknown.
- [x] Выполнить focused tests, type/lint. Транспорт не запускает 1С и не меняет endpoint или креды.

## Task 2: Session, Attach and managed launch

**Files:** src/vanessaControlSession.ts, src/vanessaControlConnection.ts, src/startupInfobase.ts и отдельный модуль подготовки MCP-компонентов, src/vanessaDebugClients.ts (reuse only), src/phaseSwitcher.ts (Open Vanessa menu), src/extension.ts, package.json/nls/l10n; новые focused tests.

**Interfaces:** immutable session snapshot with generation/capabilities/status; `attach`, `detach`, `run`, `stop`, `refreshState`. Endpoint workspaceState, credentials SecretStorage. Existing saved Debug set consumed explicitly by launch adapter.

- [x] Red tests: reconnect ignores old replies; attach/detach не запускают тест и не закрывают чужую Vanessa; credentials отсутствуют в state/log.
- [x] Red tests подготовки: повторное использование devkit нужной версии; отсутствие компонентов; ошибка установки не помечает состояние готовым; обычная сборка без MCP; конкурирующие запросы сборки/управления; активные служебные сеансы; отсутствие VAExtension в клиенте не блокирует менеджер.
- [x] Встроить компонентную подготовку MCP в существующую служебную ИБ KOT по требованию managed launch. Закрепить совместимую поставку devkit/транспорта, учитывать версии/хеши, не пересоздавать ИБ для установки компонентов и не обновлять их во время активных сеансов.
- [x] Сериализовать mutations; Stop/state обходят ожидающий run. Запретить select_step, меняющий общий MCP task ID, пока run активен.
- [x] Добавить native endpoint picker и управление сохранёнными endpoints. Managed launch задаёт runMcp/mcpPort явно и ждёт readiness с отменой.
- [x] Показать prerequisites/capabilities/status в существующем Test Manager без новой постоянной кнопки на каждом тесте.
- [x] Проверить обычный Debug/standalone launch regressions и cleanup. Live capability handshake проверить в disposable базе до следующего этапа.

## Task 3: Standalone feature control

**Files:** src/vanessaControlCommands.ts, src/featureEditorCodeLens.ts или отдельный control provider, src/phaseSwitcher.ts, package.json/nls/l10n; test/vanessaControlCommands.test.ts.

- [x] Red tests: сохранённый исполняемый шаг, header/table/docstring/comment, dirty file, missing path, feature switched during request.
- [x] Реализовать Run from this step через reloadAndRunFromLine и One step через подтверждённый execute_feature_step schema. Проверять реальный feature и номер строки.
- [x] Показать пропуск предшествующей подготовки при первом использовании; не требовать лишнего подтверждения каждого запуска.
- [x] Отображать running/stopping/unknown/failed по данным adapter. Не считать заголовок run-response доказательством полного pass.
- [x] Добавить progress callback в транспорт и модель состояния шагов: выбранный/выполняющийся/подтверждённый результат. Progress N/M не доказывает pass/fail; финальные результаты сверяют историю коротких шагов. При неизвестном следующем шаге не угадывать его по номеру строки.
- [x] Реализовать контекстный F11 для ручного выполнения шага: ожидание завершения, отсутствие параллельных повторов, ошибка удерживает выбранную строку. Не конфликтовать с активным сторонним debugger. Live acceptance отдельно проверяет контекст переменных и переходы в условиях/циклах/вложенных вызовах.
- [x] Live acceptance: середина сценария, ошибка шага, длинный шаг + Stop, потеря соединения, повторное подключение. Сохранённые наборы клиентов не применять к live-сеансу автоматически.


## Task 4: Breakpoint synchronization

**Files:** src/vanessaControlBreakpoints.ts, src/vanessaControlDecorations.ts; команды и tests.

**Interfaces:** `reconcile(activeFeatureIdentity, desiredLines)` = list → delta toggle → list confirmation; ownership/session generation обязательны.

- [x] Red tests: timeout-after-success, retry, user-added remote breakpoint, wrong active tab, editor disabled, detach/reconnect, zero/one-based line offsets.
- [x] Реализовать decorations/toggle/list. Проверить совместимость с другими debugger providers перед использованием native VS Code Breakpoint API.
- [x] Сохранять чужие точки; remove_all не использовать при attach. Повторный toggle после таймаута выполнять только после нового list.
- [x] Live acceptance: breakpoint перед шагом, повторное выполнение с выбранного шага и цикл; UI предупреждает о сбросе счётчиков.
- [ ] Точка внутри экспортного вызова: проверенная `.45` пропустила её; поддержка не заявляется до исправления/проверки upstream.

## Task 5: Build manifest and YAML control

**Files:** src/compilerBuildManifest.ts, src/compilerBuildManifestStore.ts, src/compilerArtifacts.ts, src/compilerBuildRuntime.ts, src/phaseSwitcher.ts, src/vanessaControlSourceMapping.ts; tests manifest/mapping.

**Interfaces:** manifest binds source/dependency/profile hashes + feature/.str hashes + worker namespace. Reverse mapping returns `unmapped | unique | ambiguous | stale`.

- [x] Red tests: changed dependency/profile, missing/stale map, equal feature names in workers, repeated nested invocation, grouped features, process steps/variants.
- [x] Записывать manifest только после согласованного успешного merge; не считать старые артефакты подтверждёнными.
- [x] Реализовать точные offset conversions и picker неоднозначных вхождений. Нельзя запускать по stale/unmapped карте.
- [x] Добавить Run from YAML step и YAML breakpoint mapping только после standalone acceptance. Навигация по .str остаётся отдельным действием.
- [x] Отдельно поддержать простые Vanessa-шаги YAML до полной сборки через служебный mini-feature: таблицы/docstrings, язык, ссылки на параметры/вложения и точное обратное соответствие строк. Неразрешимые зависимости/конструкции СППР дают причину недоступности, а не приблизительный запуск. Не полагаться на отключённый `execute_step_from_text`.
- [x] Live acceptance в disposable базе с процессом, вложенным процессом, повторным сценарием, вариантами параметров и несколькими частями сборки: compiler/maps/session/controller; в Extension Development Host проверены picker восьми вхождений, результат F11 и создание/удаление маркера YAML.

## Task 6: Test-client connections

- [x] Редактор подключений и шаблонов с выбором Infobase Manager и повторным использованием модели Debug clients; без второго хранилища паролей.
- [x] Adapter profiles/connect/disconnect/close с проверкой фактической схемы; отсутствующие live-поля не терять и не считать применёнными.
- [x] Tests: 1+ клиентов, смена профиля, частичное применение, ограничения порта, отмена, ошибки и отсутствие секретов в state/log.

## Task 7: Runtime variables

- [x] Компактная панель runtime-переменных с поддержанными типами, refresh/set/delete и проверкой результата. Декларации YAML не подменяют значения живого контекста.
- [x] Tests: смена сеанса/поколения, scope, отсутствие клиента/инструмента, ошибочный тип, stale edit, lifecycle панели.

## Task 8: Form Explorer over MCP

- [x] Сверить текущий snapshot/действия/IntelliSense с MCP; [карта покрытия](../audits/2026-10-19-form-explorer-mcp.md) фиксирует недостающие функции.
- [x] Подключить MCP к существующей панели, общей модели формы и IntelliSense; добавить выбор окна и статическое обогащение из существующего индекса.
- [ ] Удалить прежний мост только после parity/live acceptance: полные строки UI-таблиц и интерактивный locator пока требуют snapshot.
- [x] Tests: окна/дерево/поля/таблицы/колонки/значения, невидимые элементы, смена клиента, stale responses, ограничения размера/доступности; no regression редактора. Живое дерево 1680 узлов и активация выбранного окна проверены на собственном клиенте; это не проверка полного захвата строк таблицы.

## Task 9: Action recording into YAML and feature

- [x] Реализовать start/stop и прямую вставку Turbo Gherkin у текущей каретки с Undo, языком и отступами (уточнение пользователя 2026-10-20: без обязательного preview).
- [x] Tests: смена активного документа во время записи, dirty/version conflicts, отмена, таблицы/docstrings, пустая запись и разрыв соединения.

## Task 10: Diagnostics and reuse of existing authoring features

- [x] Диагностическая панель/локальный пакет: состояние, версии, клиенты, результаты, скриншоты, журналы менеджера/клиента; убрать секреты из экспортируемого пакета.
- [x] Использовать существующие Library, поиск шагов, IntelliSense и локальный Gherkin validator; MCP search/check_syntax добавляет проверку текущего runtime, не дублирует offline-каталог.
- [x] Tests: отсутствующие capabilities/VAExtension, частично доступная диагностика, очистка паролей и токенов, ошибки/таймаут/отмена.

## Task 11: Completion gate and documentation

- [x] Полный `npm run vscode:prepublish`, diff check, review транспорта/секретов и жизненных циклов реализованной части.
- [x] Документация установки prerequisites, attach/managed launch, stop vs breakpoint vs new-run, unknown states и maps.
- [x] Зафиксировать фактически проверенные версии EPF/devkit/extensions и live acceptance, не обобщать тесты fake transport на любую Vanessa.
- [ ] Обновить статус плана и описание PR под реальную выполненную часть. Commit/push/release — по запросу пользователя.


### Продолжение 2026-10-20

Tasks 6–7 реализованы; переменные автоматически читаются при подключении/открытии панели. Task 8 использует общий кэш формы для панели и IntelliSense, дерево с группами, статические XML-подсказки и выбор окна клиента. Фоновое обновление проверяет идентичность без повторного анализа той же формы; явный Refresh перечитывает структуру. В `.45` активный элемент не возвращается деревом: Focus active недоступен без этого признака. Snapshot-мост сохранён для locator/полных UI-таблиц.

Task 9 проверен в Extension Development Host: прямая вставка английских шагов, один Undo, следующая запись без промежуточной вкладки, внешняя остановка при доступном признаке записи. Для новой, ещё не выполнявшейся feature пользователь разрешил Stop → сохранить прежний текст → Start без подтверждения. Этот путь проверен на живой `.45` без запуска feature, включая нативные Start/Stop в Extension Development Host; текст сохраняется и при ошибке последующего запроса состояния. При отсутствии признака записи внешнюю остановку нельзя обнаружить автоматически — явный Stop остаётся идемпотентным. Генерация показывает progress, перевод использует парный каталог выбранной версии; фоновый опрос не меняет Ready.

Task 10 реализован: диагностическая панель, явные ограниченные журналы, PNG выбранного окна, локальный ZIP, поиск шагов и проверка синтаксиса работающей Vanessa. Реальный собственный клиент подтвердил state/environment/clients/results/manager log, runtime search/check_syntax и файловый PNG `.45`; журнал клиента корректно сообщил о недостающем VAExtension. Native Export ZIP сохранён в Windows TEMP и проверен чтением архива. Ни бизнес-клиент, ни бизнес-сценарий не использовались. При отмене диагностики/ошибке чтения формы подтверждённый результат шага сохраняется.

Открытые границы: точка внутри экспортного вызова, полная parity Form Explorer и разрешение на распространение WebTransport. Коммит, push, обновление удалённого PR и релиз в эту итерацию не выполняются. Финальный `npm run vscode:prepublish`: 2252 теста, 2250 успешно, 0 ошибок, 2 пропущены; types/lint/bundle и `git diff --check` прошли. Финальное ревью: замечаний не осталось после регрессионных исправлений скрытия credential-строк, неоднозначных заголовков screenshot, сохранения записанного текста и результата шага при ошибке чтения формы.


### Исправления по замечаниям 2026-10-20

Текущая итерация описана в [плане исправлений](2026-10-20-vanessa-control-corrections.md). Автоперевод записанного/сгенерированного текста отключён по просьбе пользователя. Сохраняется raw-язык Vanessa, настройки generator/Lang согласуются при новом запуске. Проверки формы идут в нижний Output. Живая проверка 2026-10-21 показала, что повторный Stop в `.45` очищает уже полученный результат; после внешней остановки при доступном state-флаге KOT сбрасывает кнопку без второго Stop, текст остаётся в Vanessa. Автовставка после внешнего Stop требует отсутствующего read-only API. В кратком pre-execution состоянии также отсутствует recording-флаг. Узкие API и следующий интерфейс подключений описаны в [предложении](../specs/2026-10-21-vanessa-connections-and-current-element.md).

### Автоматические подсказки Form Explorer 2026-10-21

По согласованному поведению выбор доступного элемента переводит на него фокус в тест-клиенте и автоматически получает Vanessa steps. Запросы объединяются по последнему выбору, запоздавшие ответы не показываются; серверные операции остаются последовательными, поскольку фактическая отмена анализа не подтверждена. Кеш ограничен одной формой/сеансом/языком и проверяется по свежим данным элемента и сообщённому Gherkin-состоянию. Вывод — readonly-поле с выделением отдельных строк; Insert full form checks перенесена в Current form. Полный check: 2315 успешно, 2 optional skip; compile и diff check прошли. Локальный webview подтверждает свободное выделение и его сохранение при идентичных обновлениях; новая последовательность MCP не выдаётся за пройденную live-приёмку. [План](2026-10-21-form-explorer-automatic-steps.md), [оставшиеся возможности и ограничения](../audits/2026-10-21-vanessa-capabilities.md).
