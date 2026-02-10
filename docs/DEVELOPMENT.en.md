# KOT for 1C — Extension Code Documentation (EN)

<p align="center">
  <a href="../README.en.md">← Back to README</a> | <a href="./DEVELOPMENT.ru.md">Русская версия</a>
</p>

This document explains extension internals: architecture, core modules, data flow, and extension points.

## 1) Entry point and lifecycle

- Main entrypoint: `src/extension.ts`
- Activation: `onStartupFinished` (see `package.json`)
- `activate()` performs:
  - Phase Switcher webview registration;
  - eager scenario-cache initialization;
  - completion/hover/diagnostics provider registration;
  - command registration (`kotTestToolkit.*`);
  - `open/change/save/close` subscriptions for scenario post-processing.

## 2) Module map

| File | Responsibility |
|---|---|
| `src/extension.ts` | Orchestration: providers/commands wiring, save pipeline, description decorations |
| `src/phaseSwitcher.ts` | Phase Switcher webview + build flow + scenario cache + incremental cache updates |
| `src/workspaceScanner.ts` | Full scan of `paths.yamlSourceDirectory` and `TestInfo` extraction |
| `src/completionProvider.ts` | Gherkin and nested-scenario-call IntelliSense |
| `src/hoverProvider.ts` | Step and scenario-call hover (description, metrics, examples) |
| `src/scenarioDiagnostics.ts` | Diagnostics, quick fixes, local/related/global scans |
| `src/commandHandlers.ts` | Editing/navigation/autofill/formatting command handlers |
| `src/phaseSwitcherMetadata.ts` | `KOTМетаданные` parsing and migration, dual-read for legacy tags |
| `src/scenarioParameterUtils.ts` | Parameter normalization, `[]`/quotes handling, defaults extraction |
| `src/scenarioCreator.ts` | Main/nested scenario creation from templates |
| `src/yamlParametersManager.ts` | Build parameters UI and `yaml_parameters.json` generation |
| `src/stepsFetcher.ts` | Step library loading (`steps.htm`): URL -> cache -> bundled fallback |
| `src/localization.ts` | Translator with language override (`System/English/Русский`) |
| `src/yamlValidator.ts` | Scenario YAML guard (`ТипФайла: "Сценарий"`) |
| `src/types.ts` | `TestInfo` contract |

## 3) Core data model

- Main model: `TestInfo` (`src/types.ts`)
- Includes:
  - scenario header fields (`name`, `uid`, `yamlFileUri`, `relativePath`);
  - call/parameter data (`nestedScenarioNames`, `parameters`, `parameterDefaults`);
  - Phase Switcher data (`tabName`, `defaultState`, `order`);
  - `scenarioCode*` fields used by duplicate `ДанныеСценария.Код` diagnostics.

## 4) Scenario cache

Source of truth:
- `scanWorkspaceForTests()` in `src/workspaceScanner.ts` (full scan of `**/scen.yaml` under `paths.yamlSourceDirectory`).

Cache owner:
- `PhaseSwitcherProvider` (`src/phaseSwitcher.ts`), `_testCache: Map<string, TestInfo>`.

Cache update strategy:
- Full refresh: `initializeTestCache()` / `refreshTestCacheFromDisk()`.
- Incremental update on save: `upsertScenarioCacheEntryFromDocument()`.
- Dirty marking + delayed refresh on create/delete/rename/workspace change.

## 5) Save pipeline

Implemented in `src/extension.ts` via `onDidSaveTextDocument`:

1. Guard: only scenario-yaml documents are processed.
2. Debounce protection: `processingFiles`.
3. `KOTМетаданные` migration/recovery (`migrateLegacyPhaseSwitcherMetadata`).
4. Dirty flag calculation by snapshot (`Name`, calls, params).
5. Conditional operations:
   - tabs -> spaces;
   - Gherkin tables alignment;
   - nested-call parameter alignment;
   - `ВложенныеСценарии` autofill;
   - `ПараметрыСценария` autofill.
6. Auto-save after edits and debounce cleanup.

Why sections are not always refilled:
- refills are triggered only on relevant dirty changes or incomplete section detection (`shouldRefill*Section`).

## 6) Diagnostics

Provider: `ScenarioDiagnosticsProvider` (`src/scenarioDiagnostics.ts`).

Validation layers:
- local (active document);
- related parent scenarios (caller graph BFS);
- global workspace scan (manual, heavy).

Notes:
- `Maybe you meant` suggestions are enabled for local checks;
- suggestions are disabled in global scan for performance;
- duplicate code warnings are emitted from a dedicated diagnostics collection (`duplicateCodeDiagnostics`);
- quick fixes include:
  - replace with suggested step/call;
  - add missing call parameters;
  - add bracket value to parameter exclusions.

## 7) Completion and hover

Completion (`src/completionProvider.ts`):
- Gherkin steps parsed from `steps.htm`;
- nested scenario calls sourced from `_testCache`;
- call parameter lines are aligned by `=`;
- default values are resolved from:
  - called scenario `parameterDefaults`,
  - current document `ПараметрыСценария` defaults.

Hover (`src/hoverProvider.ts`):
- steps: description + example with actual literals from current line;
- nested call: `KOTМетаданные.Описание` + files/params/nested-calls counters;
- short TTL cache is used for hover metrics.

## 8) KOT metadata

File: `src/phaseSwitcherMetadata.ts`

Responsibilities:
- dual-read of legacy tags (`# PhaseSwitcher_*`) and `KOTМетаданные`;
- legacy -> `KOTМетаданные.PhaseSwitcher` migration;
- missing `Описание` insertion;
- user-content preservation (no destructive overwrite);
- duplicate top-level `KOTМетаданные` cleanup.

## 9) Scenario parameters and exclusions

- Parsing/normalization: `src/scenarioParameterUtils.ts`
- Accepted call argument forms:
  - single/double quoted;
  - bracket parameter without quotes (`[Parameter]`).
- Exclusion setting: `kotTestToolkit.editor.scenarioParameterExclusions`.

Session cache:
- implemented in `src/commandHandlers.ts` (`scenarioParameterSessionCache`);
- keeps parameter block attributes/defaults until file close, even if parameters are temporarily removed in text.

## 10) Localization

- Runtime localization: `vscode.l10n.t(...)` + `l10n/bundle.l10n*.json`.
- Contribution localization (`package.json` UI strings): `package.nls*.json`.
- Language override: `kotTestToolkit.localization.languageOverride`.

## 11) Performance guardrails

- Avoid heavy workspace scans on every text change.
- Prefer incremental cache updates over full rescans where possible.
- Keep global operations manual.
- Keep related-scenario traversal bounded (`LOCAL_DEPENDENCY_SCAN_MAX_FILES`).
- Reuse caches and debounce timers for editor events.

## 12) How to add new functionality

Add a new diagnostic:
1. Add code/message in `scenarioDiagnostics.ts`.
2. Add localization keys in `l10n/bundle.l10n.json` and `l10n/bundle.l10n.ru.json`.
3. Add quick fix in `provideCodeActions()` if needed.

Add a new command:
1. Add contribution in `package.json` (`contributes.commands` + menu).
2. Register handler in `activate()` (`src/extension.ts`).
3. Add localization for title/messages.

## 13) Minimal smoke-check after changes

- `npm run compile`
- Validate in VS Code:
  - step/call completion;
  - step/call hover;
  - diagnostics and quick fixes;
  - save pipeline behavior (alignment/autofill);
  - Phase Switcher and build flow.
