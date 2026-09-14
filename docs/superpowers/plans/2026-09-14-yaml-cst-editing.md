# YAML CST Editing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:test-driven-development for each behavior change and superpowers:verification-before-completion before claiming completion. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace regex-based YAML structural navigation with parser-backed source ranges while preserving user formatting through minimal text edits.

**Architecture:** A pure `ScenarioYamlDocument` adapter wraps `yaml@2`, shields the extension from parser node types, and returns source ranges and domain records. Existing VS Code commands keep their UI and rendering responsibilities and apply only targeted edits.

**Tech Stack:** TypeScript 5.9, `yaml@2`, Node.js `node:test`, VS Code Extension API, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-14-yaml-cst-editing-design.md`

## Global Constraints

- Keep `/Users/alexeremeev/Development/1cDrive/tests/RegressionTests/Yaml/Drive` read-only.
- Do not touch `steps.htm`, `stepsFetcher.ts`, completion/IntelliSense behavior, or AI code.
- Keep regex parsing for Gherkin text inside `ТекстСценария`.
- Never serialize an entire scenario YAML file to perform a local edit.
- Stop a mutation with an explicit error if parser diagnostics make its source range unsafe.

---

### Task 1: Add parser dependency and characterize source-range behavior

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/scenarioYamlDocument.ts`
- Create: `test/scenarioYamlDocument.test.ts`

**Interfaces:**
- Produces: `ScenarioYamlDocument.parse(source)`, `errors`, `findField`, `readScalar`, `findSection`, `readRecords`, and `requireValidForEdit` as specified in the design.
- Consumes: raw scenario YAML text only; no `vscode` dependency.

- [x] Add `yaml` as a production dependency with `npm install yaml@^2`.
- [x] Write failing tests for scalar lookup, quoted values containing `:` and `#`, comments, Cyrillic keys, an empty section, and the sequence-of-single-key-maps shape used by scenario parameters.
- [x] Write failing tests asserting exact offsets with UTF-8 BOM, LF, CRLF, and a `ТекстСценария: |` block scalar.
- [x] Implement parsing with `parseDocument` and parser node ranges. Normalize ranges to JavaScript string offsets without removing the BOM from the caller's source.
- [x] Make `requireValidForEdit()` throw a domain error containing parser diagnostics; verify a malformed document cannot yield an editable range.
- [x] Run `npm test -- --test-name-pattern="ScenarioYamlDocument"` and `npm run check:types`.
- [x] Commit with `feat: add parser-backed scenario YAML model`.

### Task 2: Migrate YAML header field helpers

**Files:**
- Modify: `src/yamlHeaderFields.ts`
- Modify: `test/yamlHeaderFields.test.ts`
- Modify: `src/scenarioHeaderInlayHintsProvider.ts`
- Modify: `src/scenarioCreator.ts`
- Modify: `src/phaseSwitcher.ts`

**Interfaces:**
- Preserve: `buildYamlHeaderFieldLine(existingLine, fieldName, value)`.
- Preserve: `findScenarioHeaderFieldLines(document)` and `findTestSettingsFieldLines(document)` result shapes.
- Preserve: `parseYamlSectionFieldValues(text, sectionName, fieldNames)`.

- [ ] Add regression tests for comments, quoted colons/hashes, CRLF, BOM, and a similarly named key inside another section.
- [ ] Run the focused tests and confirm the current line/regex implementation fails at least the ambiguous-value or range case.
- [ ] Replace `findYamlSectionStart`, `findYamlSectionEnd`, `isYamlKeyLine`, and field regex matching with `ScenarioYamlDocument` lookups.
- [ ] Convert source offsets back to VS Code line numbers only at the compatibility boundary; preserve the existing caller signatures.
- [ ] Keep scalar rendering in `buildYamlHeaderFieldLine` unchanged unless a new test demonstrates a correctness defect.
- [ ] Run `npm test -- --test-name-pattern="YAML header"`, `npm run check:types`, and `npm run lint`.
- [ ] Commit with `refactor: parse YAML header fields through CST ranges`.

### Task 3: Migrate nested-scenario structural edits

**Files:**
- Modify: `src/commandHandlers.ts`
- Create: `test/scenarioYamlEdits.test.ts`
- Modify: `src/scenarioYamlDocument.ts`

**Interfaces:**
- Add pure helpers `getSectionInsertion(source, sectionName, itemText): SourceEdit` and `getSectionBodyReplacement(source, sectionName, bodyText): SourceEdit`, where `SourceEdit` contains `{ range: SourceRange; text: string }`.
- Keep `parseCalledScenariosFromScriptBody` regex behavior unchanged.

- [ ] Write failing tests for insertion into populated and empty `ВложенныеСценарии`, replacement with a following top-level section, comments adjacent to the section, CRLF, and exact preservation of prefix/suffix source.
- [ ] Implement insertion and body replacement from `ScenarioYamlSection.bodyRange`, preserving the document newline and observed indentation.
- [ ] Replace structural regex range discovery in `insertNestedScenarioRefHandler` and `clearAndFillNestedScenarios` with the pure edit helpers.
- [ ] Keep snippet construction and Gherkin call discovery in their current owners.
- [ ] Remove only the structural fallback helpers that have no remaining callers.
- [ ] Run the focused tests, `npm run check:types`, and `npm run lint`.
- [ ] Commit with `refactor: edit nested scenarios through YAML ranges`.

### Task 4: Migrate scenario-parameter structural edits

**Files:**
- Modify: `src/commandHandlers.ts`
- Modify: `src/scenarioYamlDocument.ts`
- Modify: `test/scenarioYamlEdits.test.ts`

**Interfaces:**
- Use `readRecords('ПараметрыСценария')` for existing parameter metadata.
- Use the same `getSectionInsertion` and `getSectionBodyReplacement` helpers for mutations.
- Keep `parseUsedParametersFromScriptBody` regex behavior unchanged.

- [ ] Add failing tests for multiple records, quoted defaults, descriptions containing `:` or `#`, missing optional fields, empty sections, and source preservation after replacement.
- [ ] Replace `parseExistingParameterData` structural regex parsing with typed records from `ScenarioYamlDocument`.
- [ ] Replace structural range discovery in `insertScenarioParamHandler` and `clearAndFillScenarioParameters` with CST-backed edit helpers.
- [ ] Delete obsolete section-boundary regular expressions after confirming `rg` finds no callers.
- [ ] Run the focused tests and the complete `npm run check`.
- [ ] Commit with `refactor: edit scenario parameters through YAML ranges`.

### Task 5: Read-only corpus and final verification

**Files:**
- Create: `scripts/verifyScenarioYamlCorpus.mjs`
- Modify: `package.json`
- Modify: `docs/superpowers/plans/2026-09-14-yaml-cst-editing.md`

**Interfaces:**
- Produces: `npm run verify:yaml-corpus -- <directory>` with file count and parser error count; never writes corpus files.

- [ ] Implement a read-only corpus walker that parses every `scen.yaml`, reports relative paths for parser errors, and exits non-zero on any fatal error.
- [ ] Run it against `/Users/alexeremeev/Development/1cDrive/tests/RegressionTests/Yaml/Drive`; expect 1,885 files and zero fatal errors.
- [ ] Capture the external repository status before and after and confirm it is identical.
- [ ] Run `git diff --check`, `npm run check`, `npm run vscode:prepublish`, and `npm audit --omit=dev`.
- [ ] Inspect `rg -n` results proving no structural regex remains for the two migrated sections and no files in the excluded IntelliSense/AI scope changed.
- [ ] Record verification evidence in this plan and commit with `test: verify YAML CST compatibility`.
