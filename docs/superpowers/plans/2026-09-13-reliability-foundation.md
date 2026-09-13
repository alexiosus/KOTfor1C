# Reliability Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish a reproducible, tested, type-safe build and repair the highest-confidence correctness and process-launch defects.

**Architecture:** Unit-test pure helpers with Node Test Runner and esbuild, while VS Code integration code remains validated by strict TypeScript compilation and the production bundle. Changes are deliberately incremental so later scenario-index and activation redesign work starts from a green baseline.

**Tech Stack:** TypeScript 5.9, esbuild, Node.js `node:test`, VS Code Extension API, ESLint 9.

**Spec:** `docs/superpowers/specs/2026-09-13-reliability-foundation-design.md`

## Global Constraints

- Keep `/Users/alexeremeev/Development/1cDrive/tests/RegressionTests/Yaml/Drive` read-only.
- Do not disable strict TypeScript checks or add `any` to silence errors.
- Keep user-configured command templates unchanged; harden only built-in process launches.
- Defer the ScenarioIndex redesign, lazy activation, SecretStorage migration, and large module split to later increments.

---

### Task 1: Reproducible toolchain and test runner

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `test/scenarioParameterUtils.test.ts`

**Interfaces:**
- Consumes: existing `parseScenarioParameterDefaults(text)`.
- Produces: `npm test`, `npm run check:types`, `npm run lint`, and `npm run check` scripts that later tasks use.

- [x] Add `esbuild` as an explicit dev dependency and replace the placeholder test script with esbuild compilation plus `node --test`.
- [x] Add a smoke test that parses a real-shaped `ПараметрыСценария` block and asserts its default value.
- [x] Run `npm test` and confirm that Node reports at least one executed test.
- [x] Add `check:types`, `lint`, and `check`; make `vscode:prepublish` run `check` before bundling.
- [x] Run `npm run check` and confirm it fails specifically on the known TypeScript diagnostics.

### Task 2: Type-safe runtime repairs

**Files:**
- Modify: `src/formExplorerBuilder.ts`
- Modify: `src/formExplorerEnrichment.ts`
- Modify: `src/formExplorerExtensionGenerator.ts`
- Modify: `src/oneCPlatform.ts`
- Modify: `src/phaseSwitcher.ts`
- Modify: `src/scenarioAiDescription.ts`
- Modify: `src/scenarioCreator.ts`
- Modify: `src/startupInfobase.ts`

**Interfaces:**
- Consumes: the existing VS Code and Form Explorer public functions without signature changes except adding the missing platform path parameter to `shouldPrepareFormExplorerBuilderInfobase`.
- Produces: a zero-diagnostic strict TypeScript build with preserved runtime behavior.

- [x] Use the current failing `npm run check:types` output as the red regression test and group diagnostics by root cause.
- [x] Pass `oneCClientExePath` into the builder-cache predicate from its only caller.
- [x] Normalize optional XML nodes and QuickPick API property names according to their declared contracts.
- [x] Return the generated Form Explorer project from the progress callback instead of relying on closure mutation, and use the configured preferred infobase in the error result.
- [x] Normalize raw 1C platform entries through one raw-entry type and guard optional picker paths.
- [x] Give the Vanessa client collection an explicitly narrowed array value.
- [x] Remove the stale AI prompt variables that reference nonexistent identifiers.
- [x] Rename custom QuickPick discriminators from `kind` to `entryKind` and explicitly type each item union.
- [x] Wrap VS Code Thenables with `Promise.resolve` where native Promise storage is required.
- [x] Run `npm run check:types`; expected result is zero diagnostics.

### Task 3: Correct scenario-reference matching

**Files:**
- Create: `src/scenarioReferenceMatcher.ts`
- Create: `test/scenarioReferenceMatcher.test.ts`
- Modify: `src/navigationUtils.ts`

**Interfaces:**
- Produces: `findScenarioReference(line: string, targetName: string): { start: number; length: number } | null`.
- Consumes: exact scenario names from the existing cache/navigation command.

- [x] Write tests for `And`, `Given`, `When`, `Then`, `But`, `If`, `К тому же`, `Но`, `Тогда`, `Когда`, `Если`, `И`, and `Допустим`; include regex punctuation in the scenario name.
- [x] Run the focused test and confirm `Given` fails because the matcher module does not exist yet.
- [x] Implement the pure matcher with escaped scenario names and precise character ranges.
- [x] Replace the local three-keyword regex in `findScenarioReferences` with the matcher.
- [x] Run unit tests and a read-only corpus probe; expected result is that the known line 764 reference is matched.

### Task 4: Harden built-in process launches and dependency audit

**Files:**
- Modify: `src/commandHandlers.ts`
- Modify: `src/phaseSwitcher.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: executable path plus an argument array.
- Produces: direct `execFile`/`spawn` launches with `shell: false` for built-in commands.

- [x] Replace the MXL shell command string with `execFile(fileWorkshopPath, [filePath], callback)`.
- [x] Pass the raw executable path to both PhaseSwitcher `spawn` calls and set `shell: false`.
- [x] Upgrade `uuid` to a release outside `<11.1.1` and regenerate the lockfile.
- [x] Run `npm audit --omit=dev`, `npm run check`, and `npm run vscode:prepublish`.

### Task 5: Final compatibility verification

**Files:**
- Modify: `docs/superpowers/plans/2026-09-13-reliability-foundation.md`

**Interfaces:**
- Consumes: all deliverables above.
- Produces: recorded verification evidence for the next optimization increment.

- [ ] Run `git diff --check` and inspect every changed file.
- [ ] Run the full unit suite, type checker, linter, production prepublish build, and production dependency audit.
- [ ] Recount the external corpus and verify it has 1,885 `scen.yaml` files and no modified files.
- [ ] Record remaining deferred work: duplicate-name-aware ScenarioIndex, lazy activation/completion indexing, SecretStorage, YAML CST migration, and module decomposition.
