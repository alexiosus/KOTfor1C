# Vanessa control Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans. Follow the compatibility gates before claiming live execution support. Preserve the existing checkout and saved Debug launch behavior.

**Goal:** Управлять совместимой запущенной Vanessa из VS Code: начать со standalone feature, затем breakpoints, затем YAML со свежей source map.

**Architecture:** MCP transport отдельно от state machine и VS Code UI. Выполнение, остановка и чтение состояния имеют разные очереди. Typed adapter изолирует Markdown внешний протокол. Встроенный компилятор и Debug launch не переписываются.

**Tech Stack:** TypeScript, VS Code commands/decorations, существующие native tests, официальный MCP SDK после проверки/фиксации поддержанной версии. Без LLM в рабочем runtime.

**Spec:** [Дизайн](../specs/2026-10-15-vanessa-control-design.md), [проверенные источники](../audits/2026-10-14-vanessa-debug-control.md#перепроверка-2026-10-15).

## Constraints

- Это следующий план, а не завершённая реализация. Не добавлять команды до подтверждения нужных tools/schema.
- Не запускать/менять производственные базы для проверки; live acceptance — в disposable окружении, выбранном пользователем.
- Не устанавливать автоматически devkit или расширения в базы. Attach без endpoint выдаёт понятную причину.
- Не называть повторный запуск Continue и не предлагать BSL step-over без внешней capability.
- Без установки версии SDK по памяти: проверить официальную документацию и lockfile на этапе реализации.

## Task 1: Capability contract and transport

**Files:** src/vanessaControlProtocol.ts, src/vanessaControlTransport.ts, test/vanessaControlProtocol.test.ts, test/vanessaControlTransport.test.ts; package.json/lock только при выборе SDK.

**Interfaces:** `ControlTransport.initialize(endpoint, signal)`, `listTools()`, `callTool(name,args,signal)`, `dispose()`; normalized capability set и typed response union. Tool names/argument schema проверяются с сервером.

- [ ] Добавить fixtures фактических tools/list и Markdown state/results/breakpoints из проверенного релиза, без учётных данных.
- [ ] Red tests: отсутствующая capability, изменённая schema, unknown Markdown, SSE disconnect, timeout, late response, cancel.
- [ ] Реализовать initialize/negotiation/transport cleanup; неизвестный формат возвращает unknown.
- [ ] Выполнить focused tests, type/lint. Транспорт не запускает 1С и не меняет endpoint или креды.

## Task 2: Session, Attach and managed launch

**Files:** src/vanessaControlSession.ts, src/vanessaControlConnection.ts, src/vanessaDebugClients.ts (reuse only), src/phaseSwitcher.ts (Open Vanessa menu), src/extension.ts, package.json/nls/l10n; новые focused tests.

**Interfaces:** immutable session snapshot with generation/capabilities/status; `attach`, `detach`, `run`, `stop`, `refreshState`. Endpoint workspaceState, credentials SecretStorage. Existing saved Debug set consumed explicitly by launch adapter.

- [ ] Red tests: reconnect ignores old replies; attach/detach не запускают тест и не закрывают чужую Vanessa; credentials отсутствуют в state/log.
- [ ] Сериализовать mutations; Stop/state обходят ожидающий run. Запретить select_step, меняющий общий MCP task ID, пока run активен.
- [ ] Добавить native endpoint picker и управление сохранёнными endpoints. Managed launch задаёт runMcp/mcpPort явно и ждёт readiness с отменой.
- [ ] Показать prerequisites/capabilities/status в существующем Test Manager без новой постоянной кнопки на каждом тесте.
- [ ] Проверить обычный Debug/standalone launch regressions и cleanup. Live capability handshake проверить в disposable базе до следующего этапа.

## Task 3: Standalone feature control

**Files:** src/vanessaControlCommands.ts, src/featureEditorCodeLens.ts или отдельный control provider, src/phaseSwitcher.ts, package.json/nls/l10n; test/vanessaControlCommands.test.ts.

- [ ] Red tests: сохранённый исполняемый шаг, header/table/docstring/comment, dirty file, missing path, feature switched during request.
- [ ] Реализовать Run from this step через reloadAndRunFromLine и One step через подтверждённый execute_feature_step schema. Проверять реальный feature и номер строки.
- [ ] Показать пропуск предшествующей подготовки при первом использовании; не требовать лишнего подтверждения каждого запуска.
- [ ] Отображать running/stopping/unknown/failed по данным adapter. Не считать заголовок run-response доказательством полного pass.
- [ ] Live acceptance: середина сценария, ошибка шага, длинный шаг + Stop, потеря соединения, повторное подключение. Сохранённые наборы клиентов не применять к live-сеансу автоматически.

## Task 4: Breakpoint synchronization

**Files:** src/vanessaControlBreakpoints.ts, src/vanessaControlDecorations.ts; команды и tests.

**Interfaces:** `reconcile(activeFeatureIdentity, desiredLines)` = list → delta toggle → list confirmation; ownership/session generation обязательны.

- [ ] Red tests: timeout-after-success, retry, user-added remote breakpoint, wrong active tab, editor disabled, detach/reconnect, zero/one-based line offsets.
- [ ] Реализовать decorations/toggle/list. Проверить совместимость с другими debugger providers перед использованием native VS Code Breakpoint API.
- [ ] Сохранять чужие точки; remove_all не использовать при attach. Повторный toggle после таймаута выполнять только после нового list.
- [ ] Live acceptance: breakpoint перед шагом, повторное выполнение с выбранного шага, цикл и вложенный сценарий. Текст UI отражает сброс счётчиков циклов.

## Task 5: Build manifest and YAML control

**Files:** src/compilerBuildManifest.ts, src/compilerArtifacts.ts, src/compilerBuildRuntime.ts, src/phaseSwitcher.ts, src/vanessaControlSourceMapping.ts; tests manifest/mapping.

**Interfaces:** manifest binds source/dependency/profile hashes + feature/.str hashes + worker namespace. Reverse mapping returns `unmapped | unique | ambiguous | stale`.

- [ ] Red tests: changed dependency/profile, missing/stale map, equal feature names in workers, repeated nested invocation, grouped features, process steps/variants.
- [ ] Записывать manifest только после согласованного успешного merge; не считать старые артефакты подтверждёнными.
- [ ] Реализовать точные offset conversions и picker неоднозначных вхождений. Нельзя запускать по stale/unmapped карте.
- [ ] Добавить Run from YAML step и YAML breakpoint mapping только после standalone acceptance. Навигация по .str остаётся отдельным действием.
- [ ] Live acceptance в disposable базе с процессом, вложенным процессом, повторным сценарием и несколькими частями сборки.

## Task 6: Completion gate and documentation

- [ ] Полный `npm run vscode:prepublish`, diff check, review транспорта/секретов и всех жизненных циклов.
- [ ] Документация установки prerequisites, attach/managed launch, stop vs breakpoint vs new-run, unknown states и maps.
- [ ] Зафиксировать фактически проверенные версии EPF/devkit/extensions и live acceptance, не обобщать тесты fake transport на любую Vanessa.
- [ ] Обновить статус плана и описание PR под реальную выполненную часть. Commit/push/release — по запросу пользователя.
