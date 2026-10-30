# Project Step Libraries and Export Scenarios Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make source-backed user steps and exported feature scenarios first-class project definitions used by completion, hover, diagnostics, F12, Shift+F12, reference search, and shared creation workflows, without indexing binary-only EPFs or delaying extension activation.

**Architecture:** Pure parsers produce a common immutable definition model. A workspace-folder/profile-scoped index service resolves active library roots, restores a persistent per-file cache, scans in the background with bounded concurrency, and atomically publishes snapshots. A composite resolver joins that local snapshot with the existing nested-scenario catalog and resource-specific built-in Vanessa catalog; all editor consumers depend on this resolver rather than scanning independently. Creation and explicit EPF build are separate services invoked by palette commands, diagnostics Quick Fixes, and the Test Manager menu.

**Tech Stack:** TypeScript 5.8, Node.js 20 APIs, VS Code 1.98 extension API, existing `yaml` and `node-html-parser` dependencies, esbuild, Node test runner, 1C Designer command-line interface.

**Spec:** `docs/superpowers/specs/2026-09-23-project-definitions-design.md`

## Global Constraints

- Index only the active KOT profile for the workspace folder containing the requesting document.
- Do not dump, parse, or claim support for binary-only `.epf` libraries in this version.
- Do not block activation, first built-in completion, or nested-scenario loading on local project indexing.
- Keep project scanners out of `PhaseSwitcherProvider`; use a narrow scenario-catalog adapter.
- Resolve library roots in this order: effective `КаталогиБиблиотек`/`librarycatalogs`, then build `Libraries`, then build `VanessaLibraries`.
- Resolve `#SourcesPath` and `#Libraries` against the owning workspace folder; never guess an unresolved `#Token`.
- Preserve duplicate definitions. Completion labels origins; semantic resolution reports ambiguity instead of silently choosing a source.
- Use one matcher for hover, definition, references, and diagnostics. Completion may rank project definitions higher but may not change semantic resolution.
- Store cache files in extension storage, never in the user's repository.
- Use bounded asynchronous filesystem work, cancellation, immutable snapshots, and stale-generation suppression.
- Preserve BOM, EOL style, indentation, and final-newline state when editing an existing feature.
- Modify BSL only at parser-proven insertion ranges. Refuse unsafe or ambiguous edits.
- Build `.epf` only on an explicit command. Pass Designer arguments as an array with `shell: false`, write a temporary binary, validate it, then atomically replace the target.
- Reuse existing platform selection, startup-infobase, localization, command-display redaction, and output-channel conventions.
- Keep external 1cDrive tests and the Vanessa checkout read-only; all automated fixtures live in this repository.

## Review Focus

- Profile changes during a slow scan must never publish definitions from the previous profile; pinned by Task 6 cancellation and generation tests.
- Gherkin tags, comments, examples, tables, doc strings, BOM, and CRLF must not create false export definitions; pinned by Task 3 parser tests.
- BSL comments, doubled quotes, multiline calls, balanced parentheses, static concatenation, and dynamic expressions must be handled without regex-based false positives; pinned by Task 4 parser tests.
- Same-text definitions from multiple libraries must remain visible and ambiguous across completion, hover, F12, and diagnostics; pinned by Tasks 5, 7, 8, and 9.
- A failed or cancelled Designer run must preserve the existing `.epf`; pinned by Task 13 atomic-build tests.
- Activation must register providers and return before local enumeration completes; pinned by Task 14 activation-contract tests.

---

### Task 1: Common Definition Contract and Template Matcher

**Files:**
- Create: `src/projectDefinition.ts`
- Create: `src/projectDefinitionMatcher.ts`
- Create: `test/projectDefinitionMatcher.test.ts`

**Interfaces:**
- Produces `ProjectDefinition`, `ProjectDefinitionParameter`, `ProjectDefinitionLocation`, `ProjectDefinitionSnapshot`, `ProjectDefinitionView`, `ProjectDefinitionResolution`, `createLocalDefinitionId()`, `compileProjectDefinitionMatcher()`, and `resolveProjectInvocation()`.
- Consumes no VS Code API; URIs are strings and ranges use serializable line/character values.

- [ ] **Step 1: Write failing contract and matcher tests**

Cover exact nested-scenario names, quoted positional placeholders, outline placeholders, repeated literals, RU/EN keywords, ambiguity, and stable local IDs:

```ts
test('matches parameterized calls and preserves argument ranges', () => {
    const definition = makeDefinition({ template: 'я ввожу "Имя" в поле "Значение"' });
    const result = resolveProjectInvocation(
        createProjectDefinitionView('view-1', [definition]),
        'И я ввожу "Логин" в поле "Администратор"'
    );
    assert.equal(result.kind, 'unique');
    assert.deepEqual(result.match.arguments.map(item => item.value), ['Логин', 'Администратор']);
});

test('does not collapse definitions with the same template', () => {
    const result = resolveProjectInvocation(
        createProjectDefinitionView('view-1', [
            makeDefinition({ id: 'a', template: 'And shared step' }),
            makeDefinition({ id: 'b', template: 'And shared step' })
        ]),
        'And shared step'
    );
    assert.equal(result.kind, 'ambiguous');
    assert.deepEqual(result.matches.map(item => item.definition.id), ['a', 'b']);
});
```

- [ ] **Step 2: Run the focused test and verify the missing-module failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionMatcher.test.js`

Expected: FAIL because `src/projectDefinition.ts` and `src/projectDefinitionMatcher.ts` do not exist.

- [ ] **Step 3: Implement the serializable model**

Use these public shapes:

```ts
export type ProjectDefinitionKind =
    | 'builtInStep'
    | 'userStep'
    | 'exportScenario'
    | 'nestedScenario';

export interface ProjectDefinitionLocation {
    readonly uri: string;
    readonly range: {
        readonly start: { readonly line: number; readonly character: number };
        readonly end: { readonly line: number; readonly character: number };
    };
}

export interface ProjectDefinitionParameter {
    readonly name: string;
    readonly index: number;
    readonly source: 'quoted' | 'outline' | 'snippet';
}

export interface ProjectDefinition {
    readonly id: string;
    readonly kind: ProjectDefinitionKind;
    readonly template: string;
    readonly normalizedTemplate: string;
    readonly language?: 'ru' | 'en';
    readonly parameters: readonly ProjectDefinitionParameter[];
    readonly description?: string;
    readonly category?: string;
    readonly sourceLabel: string;
    readonly workspaceFolderUri?: string;
    readonly profileId?: string;
    readonly libraryRootUri?: string;
    readonly definitionLocation?: ProjectDefinitionLocation;
    readonly implementationLocation?: ProjectDefinitionLocation;
}

export interface ProjectDefinitionView {
    readonly identity: string;
    readonly all: readonly ProjectDefinition[];
    readonly byId: ReadonlyMap<string, ProjectDefinition>;
    readonly byNormalizedTemplate: ReadonlyMap<string, readonly ProjectDefinition[]>;
}

export interface ProjectDefinitionMatch {
    readonly definition: ProjectDefinition;
    readonly invocationRange: { readonly start: number; readonly end: number };
    readonly arguments: readonly {
        readonly parameter: ProjectDefinitionParameter;
        readonly value: string;
        readonly start: number;
        readonly end: number;
    }[];
}

export type ProjectDefinitionResolution =
    | { readonly kind: 'missing'; readonly invocation: string }
    | { readonly kind: 'unique'; readonly match: ProjectDefinitionMatch }
    | { readonly kind: 'ambiguous'; readonly matches: readonly ProjectDefinitionMatch[] };
```

Hash local IDs with SHA-256 over kind, normalized URI, source range, and normalized signature. Normalize line breaks and whitespace without changing original display text. Keep matcher compilation linear in template length and cache compiled matchers by definition ID within a view.

- [ ] **Step 4: Implement one deterministic resolution path**

Strip only a recognized leading Gherkin keyword, match literal segments and ordered placeholders, return exact argument offsets, sort equal matches by `kind`, `sourceLabel`, then `id`, and return `missing`, `unique`, or `ambiguous`. Never construct a regex from unescaped source text.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionMatcher.test.js`

Expected: PASS.

```bash
git add src/projectDefinition.ts src/projectDefinitionMatcher.ts test/projectDefinitionMatcher.test.ts
git commit -m "feat: add project definition model"
```

### Task 2: Active-profile Library and Vanessa Path Resolution

**Files:**
- Create: `src/projectLibraryRoots.ts`
- Create: `test/projectLibraryRoots.test.ts`
- Modify: `src/yamlParametersManager.ts`
- Modify: `src/vanessaLaunchJson.ts`
- Modify: `test/vanessaLaunchJson.test.ts`

**Interfaces:**
- `YamlParametersManager.loadActiveProfileSnapshot(): Promise<ActiveYamlParametersProfile>` returns defensive copies of profile ID/name, build parameters, additional Vanessa parameters, and global variables.
- `YamlParametersManager.onDidChangeActiveProfile` fires after active-profile selection or any save affecting the active profile.
- `resolveProjectLibraryConfiguration(input)` returns roots, feature folders, Vanessa installation candidates, warnings, and an identity string.

- [ ] **Step 1: Write failing path-resolution tests**

Test alias precedence, `overrideExisting`, array and path-delimited strings, `Libraries`/`VanessaLibraries` fallback, relative paths, Windows drive paths, UNC paths, multi-root ownership, duplicate normalization, `#SourcesPath`, `#Libraries`, `FeatureFolder`, Vanessa path aliases, and unresolved-token warnings.

```ts
test('prefers effective Vanessa librarycatalogs over build fallbacks', () => {
    const result = resolveProjectLibraryConfiguration({
        workspaceFolderPath: 'C:\\repo',
        profileId: 'active',
        buildParameters: [{ key: 'Libraries', value: '#Libraries\\fallback' }],
        additionalVanessaParameters: [{
            key: 'librarycatalogs',
            value: '["#Libraries\\one", "#Libraries\\two"]',
            overrideExisting: true
        }],
        pathApi: path.win32
    });
    assert.deepEqual(result.libraryRootPaths, ['C:\\repo\\one', 'C:\\repo\\two']);
});
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm run compile-tests && node --test out/test/projectLibraryRoots.test.js out/test/vanessaLaunchJson.test.js`

Expected: FAIL because the resolver and active-profile snapshot API do not exist.

- [ ] **Step 3: Expose alias lookup and an immutable active-profile snapshot**

Export a read-only alias helper from `vanessaLaunchJson.ts` instead of duplicating the alias table. Add:

```ts
export interface ActiveYamlParametersProfile {
    readonly id: string;
    readonly name: string;
    readonly buildParameters: readonly YamlParameter[];
    readonly additionalVanessaParameters: readonly AdditionalVanessaParameter[];
    readonly globalVanessaVariables: readonly GlobalVanessaVariable[];
}
```

Fire one change event only after successful storage. Include `{ oldProfileId, newProfileId, reason }`, where reason is `selection` or `content`. Existing callers remain source-compatible.

- [ ] **Step 4: Implement pure configuration resolution**

Parse JSON array values when valid; otherwise split a scalar on the injected platform delimiter. Resolve tokens only at path-segment boundaries. Return unresolved values as deduplicated warnings and exclude them. Compute identity from profile ID plus normalized ordered roots/feature folders/Vanessa candidates.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectLibraryRoots.test.js out/test/vanessaLaunchJson.test.js`

Expected: PASS.

```bash
git add src/projectLibraryRoots.ts src/yamlParametersManager.ts src/vanessaLaunchJson.ts test/projectLibraryRoots.test.ts test/vanessaLaunchJson.test.ts
git commit -m "feat: resolve active project libraries"
```

### Task 3: Export Scenario Parser

**Files:**
- Create: `src/exportScenarioParser.ts`
- Create: `test/exportScenarioParser.test.ts`
- Create: `test/fixtures/project-definitions/export-ru.feature`
- Create: `test/fixtures/project-definitions/export-en.feature`

**Interfaces:**
- `parseExportScenarios(source, context): ExportScenarioParseResult`
- `context` supplies source URI, workspace/profile/root identities, and default language.
- Result contains definitions, warnings, language, EOL, BOM, feature tag state, and parser-proven scenario insertion metadata reused by creation.

- [ ] **Step 1: Add failing RU/EN fixture tests**

Cover feature-level and scenario-level `@ExportScenarios`, `Сценарий`, `Scenario`, `Scenario Outline`, `Структура сценария`, descriptions, quoted arguments, `<outline>` placeholders, comments, examples, data tables, doc strings, BOM, CRLF, and non-export/background exclusion.

- [ ] **Step 2: Run and verify the missing parser**

Run: `npm run compile-tests && node --test out/test/exportScenarioParser.test.js`

Expected: FAIL because `src/exportScenarioParser.ts` does not exist.

- [ ] **Step 3: Implement the line-oriented state machine**

Track language, pending tags, feature tags, current scenario, doc-string state, and scenario-description lines. Recognize keyword sets through `src/gherkinLanguage.ts`; extend that module only if the required scenario/outline/structure forms are not exported. Record the title range, full declaration range, parameters, and safe end-of-feature insertion point. Treat tables and examples as bodies, not definitions.

- [ ] **Step 4: Convert parsed declarations into common definitions**

Use `createLocalDefinitionId()`, retain source spelling, and set `definitionLocation` to the title. The first implementation step is not a separate location for export scenarios. Emit file-scoped warnings for malformed declarations while retaining other valid scenarios.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/exportScenarioParser.test.js out/test/projectDefinitionMatcher.test.js`

Expected: PASS.

```bash
git add src/exportScenarioParser.ts src/gherkinLanguage.ts test/exportScenarioParser.test.ts test/fixtures/project-definitions/export-ru.feature test/fixtures/project-definitions/export-en.feature
git commit -m "feat: parse exported feature scenarios"
```

### Task 4: Lexical BSL User-step Parser

**Files:**
- Create: `src/bslStepSourceParser.ts`
- Create: `test/bslStepSourceParser.test.ts`
- Create: `test/fixtures/project-definitions/UserSteps.bsl`

**Interfaces:**
- `scanBslTokens(source): readonly BslToken[]`
- `parseUserStepSource(source, context): UserStepSourceParseResult`
- Result includes definitions, warnings, `ПолучитьСписокТестов` body insertion range, module append range, and function/procedure declaration ranges.

- [ ] **Step 1: Write failing lexical and registration tests**

Pin comments containing fake calls, doubled quotes, multiline calls, balanced nested expressions, static string variables, concatenation, several registrations, optional category, implementation lookup, registration fallback, and one dynamic expression skipped while neighboring static registrations survive.

```ts
test('skips only a dynamic registration and reports its range', () => {
    const result = parseUserStepSource(sourceWithStaticAndDynamicCalls, context);
    assert.deepEqual(result.definitions.map(item => item.template), ['И статический шаг']);
    assert.match(result.warnings[0].message, /dynamic expression/i);
    assert.equal(result.warnings[0].range.start.line, 8);
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/bslStepSourceParser.test.js`

Expected: FAIL because `src/bslStepSourceParser.ts` does not exist.

- [ ] **Step 3: Implement the lexer and static evaluator**

Tokenize identifiers, punctuation, newlines, comments, and BSL strings with doubled-quote escapes. Collect static local string assignments and evaluate only string literals, known static identifiers, parenthesized static expressions, and `+` concatenation. Do not execute code or interpolate unknown expressions.

- [ ] **Step 4: Parse registrations and declarations**

Recognize member calls whose final identifier is `ДобавитьШагВМассивТестов`; split arguments by balanced delimiters; extract destination, snippet, implementation name, displayed template, description, and category/type. Prefer a statically named function/procedure declaration as `implementationLocation`; otherwise use the registration. Compute safe insertion ranges only when exactly one `ПолучитьСписокТестов` body and one module boundary are proven.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/bslStepSourceParser.test.js`

Expected: PASS.

```bash
git add src/bslStepSourceParser.ts test/bslStepSourceParser.test.ts test/fixtures/project-definitions/UserSteps.bsl
git commit -m "feat: parse source-backed user steps"
```

### Task 5: Immutable Local Snapshot Builder

**Files:**
- Create: `src/projectDefinitionIndex.ts`
- Create: `test/projectDefinitionIndex.test.ts`

**Interfaces:**
- `buildProjectDefinitionSnapshot(input): ProjectDefinitionSnapshot`
- `updateProjectDefinitionSnapshot(previous, fileResult): ProjectDefinitionSnapshot`
- Snapshot contains `identity`, `generation`, ordered definitions, per-file records, warnings, and indexes by ID/template/source URI.

```ts
export interface ProjectDefinitionSnapshot {
    readonly identity: string;
    readonly workspaceFolderUri: string;
    readonly profileId: string;
    readonly generation: number;
    readonly definitions: readonly ProjectDefinition[];
    readonly files: ReadonlyMap<string, ProjectDefinitionFileRecord>;
    readonly warnings: readonly ProjectDefinitionWarning[];
    readonly byId: ReadonlyMap<string, ProjectDefinition>;
    readonly byNormalizedTemplate: ReadonlyMap<string, readonly ProjectDefinition[]>;
}
```

- [ ] **Step 1: Write failing snapshot tests**

Test deterministic ordering independent of read completion order, duplicate retention, stable identities, removal of one file, malformed-file isolation, warning deduplication, and structural sharing for unchanged file records.

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionIndex.test.js`

Expected: FAIL because the snapshot builder does not exist.

- [ ] **Step 3: Implement deterministic snapshot assembly**

Sort files by normalized URI and definitions by source range. Freeze public arrays and maps by construction, never mutate a published snapshot, and include parser version plus configuration identity in snapshot identity. Keep same-text definitions in separate buckets.

- [ ] **Step 4: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionIndex.test.js`

Expected: PASS.

```bash
git add src/projectDefinitionIndex.ts test/projectDefinitionIndex.test.ts
git commit -m "feat: build immutable project definition snapshots"
```

### Task 6: Background Index Service, Persistent Cache, and Watchers

**Files:**
- Create: `src/projectDefinitionIndexService.ts`
- Create: `src/projectDefinitionCache.ts`
- Create: `test/projectDefinitionIndexService.test.ts`
- Modify: `src/boundedConcurrency.ts`
- Modify: `test/boundedConcurrency.test.ts`

**Interfaces:**
- `ProjectDefinitionIndexProvider.getSnapshot(resource?: vscode.Uri): ProjectDefinitionSnapshot | null`
- `ProjectDefinitionIndexProvider.ensureReady(resource?: vscode.Uri, token?: vscode.CancellationToken): Promise<ProjectDefinitionSnapshot>`
- `ProjectDefinitionIndexProvider.onDidChangeSnapshot: vscode.Event<ProjectDefinitionSnapshotChangeEvent>`
- `ProjectDefinitionIndexService.start()` schedules work and returns synchronously.

- [ ] **Step 1: Write failing lifecycle tests with injected filesystem and scheduler**

Test cache reuse by URI/size/mtime/parser version, one-file invalidation, watcher create/change/delete, root changes, disposal, bounded enumeration/read concurrency, cancellation, stale profile-generation suppression, and a deduplicated summary warning for binary-only `.epf` libraries.

```ts
test('does not publish a completed scan after the active profile changes', async () => {
    const first = deferred<FileRecord[]>();
    const service = createService({ firstEnumeration: first.promise });
    service.startProfile(profileA);
    service.startProfile(profileB);
    first.resolve(recordsForA);
    await service.waitForIdle();
    assert.equal(service.getSnapshot()?.profileId, 'profile-b');
});
```

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionIndexService.test.js out/test/boundedConcurrency.test.js`

Expected: FAIL because the service and cache do not exist.

- [ ] **Step 3: Implement versioned cache serialization**

Store under `context.storageUri/project-definitions/` when available, otherwise `globalStorageUri/project-definitions/<workspace-hash>/`. Write via temporary file plus rename. Reject wrong schema/parser/configuration identities and malformed cached records without failing the scan.

- [ ] **Step 4: Implement folder/profile coordinators**

Resolve a configuration per workspace folder, restore cached records, publish a consistent cached snapshot, then refresh in the background. Enumerate only `.feature` and `.bsl` definitions below active roots, ignoring `node_modules`, `.git`, and duplicate physical paths. Count `.epf` files under `step_definitions` only to produce one snapshot warning when the corresponding source library is absent; never read their contents. Use `runWithConcurrencyLimit()` with a Windows/network-safe default of 8 reads and periodic event-loop yields.

- [ ] **Step 5: Add incremental watchers and profile invalidation**

Create one relative-pattern watcher per root when VS Code can watch it. Reparse only the affected supported file. On profile/config change: increment generation, cancel old work, dispose old watchers, and publish only when the new snapshot is internally complete. Log each unresolved root/parser warning once per snapshot.

- [ ] **Step 6: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionIndexService.test.js out/test/projectDefinitionIndex.test.js out/test/boundedConcurrency.test.js`

Expected: PASS.

```bash
git add src/projectDefinitionIndexService.ts src/projectDefinitionCache.ts src/boundedConcurrency.ts test/projectDefinitionIndexService.test.ts test/boundedConcurrency.test.ts
git commit -m "feat: index project definitions in background"
```

### Task 7: Composite Resolver for All Four Definition Kinds

**Files:**
- Create: `src/projectDefinitionResolver.ts`
- Create: `test/projectDefinitionResolver.test.ts`
- Modify: `src/scenarioCatalog.ts`

**Interfaces:**
- `ScenarioCatalogProvider` is moved to/exported from `scenarioCatalog.ts` with `getScenarioCatalog()`, `ensureFreshScenarioCatalog()`, and `onDidUpdateScenarioCatalog`.
- `ProjectDefinitionResolver.getView(resource?: vscode.Uri): Promise<ProjectDefinitionView>` composes local, nested, and built-in definitions.
- `ProjectDefinitionResolver.resolve(resource, invocation): Promise<ProjectDefinitionResolution>` uses the shared matcher.
- `ProjectDefinitionResolver.onDidChangeView` invalidates consumers by workspace/resource identity.

- [ ] **Step 1: Write failing composition tests**

Test all four kinds, two folders using different built-in catalog identities, no local snapshot yet, nested duplicates, project/built-in duplicates, deterministic labels, and local snapshot change invalidation.

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionResolver.test.js`

Expected: FAIL because `ProjectDefinitionResolver` does not exist.

- [ ] **Step 3: Implement adapters rather than changing producer models**

Convert each `BuiltInStepDefinition` language variant into a project definition with no local location. Convert each `TestInfo` into one nested definition using exact scenario name and YAML URI. Use the local snapshot as-is. Compute the scenario portion of view identity from the sorted nested URI/signature pairs; do not add mutable identity state to `ScenarioCatalog`. View identity must include built-in catalog identity, computed scenario identity, and local snapshot identity.

- [ ] **Step 4: Preserve unavailable-local behavior**

`getView()` may use the current local snapshot immediately; it must not await initial local indexing. `ensureReady()` remains available to explicit project-definition commands. Built-in catalog behavior remains cache-first and resource-scoped.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionResolver.test.js out/test/scenarioCatalog.test.js out/test/stepCatalogService.test.js`

Expected: PASS.

```bash
git add src/projectDefinitionResolver.ts src/scenarioCatalog.ts test/projectDefinitionResolver.test.ts
git commit -m "feat: compose unified project definitions"
```

### Task 8: Completion and Hover Integration

**Files:**
- Modify: `src/completionProvider.ts`
- Modify: `src/hoverProvider.ts`
- Modify: `src/extension.ts`
- Create: `test/projectDefinitionEditorProviders.test.ts`
- Modify: `test/completionMultilinePreview.test.ts`

**Interfaces:**
- `DriveCompletionProvider` and `DriveHoverProvider` receive `ProjectDefinitionResolver` instead of independently combining step and scenario sources.
- Existing exported snippet helpers remain compatible with Form Explorer consumers.

- [ ] **Step 1: Write failing provider tests**

Using a minimal VS Code stub, assert that user steps and export scenarios appear, project definitions rank before equal built-ins, duplicates remain separate with source labels, multiline previews remain multiline, hover lists every ambiguous source, and an unavailable local snapshot does not block built-in results.

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionEditorProviders.test.js out/test/completionMultilinePreview.test.js`

Expected: FAIL because providers do not consume the unified resolver.

- [ ] **Step 3: Refactor completion state around definition-view identity**

Cache prepared completion state by `ProjectDefinitionView.identity`. Build snippets and semantic entries from all definitions. Keep current fuzzy score, language filtering, variable completions, and table snippets. Prefix `sortText` only as a tiebreaker so local project kinds precede built-ins without hiding conflicts.

- [ ] **Step 4: Refactor hover around shared resolution**

Render kind, source label, description, category, parameters, relative path, and `kotTestToolkit.openProjectDefinition` link. For ambiguity, render one entry/link per definition. Built-ins continue showing catalog documentation without an open link.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionEditorProviders.test.js out/test/completionMultilinePreview.test.js out/test/stepSuggestionIndex.test.js`

Expected: PASS.

```bash
git add src/completionProvider.ts src/hoverProvider.ts src/extension.ts test/projectDefinitionEditorProviders.test.ts test/completionMultilinePreview.test.ts
git commit -m "feat: surface project definitions in editor hints"
```

### Task 9: Unified Diagnostics and Creation Quick Fixes

**Files:**
- Modify: `src/scenarioDiagnostics.ts`
- Modify: `src/extension.ts`
- Create: `test/projectDefinitionDiagnostics.test.ts`

**Interfaces:**
- Diagnostics depend on `ProjectDefinitionResolver.resolve()` and no longer call `hoverProvider.isKnownStepLine()` as a semantic API.
- Unknown calls offer `kotTestToolkit.createExportScenario` and `kotTestToolkit.createUserStep` actions with a serializable seed `{ invocation, language, documentUri, range }`.

- [ ] **Step 1: Write failing diagnostic tests**

Cover recognition of all four kinds, project-vs-built-in ambiguity, two local sources with the same template, missing definitions, cancellable similarity suggestions, and both creation Quick Fix commands carrying the unknown invocation.

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionDiagnostics.test.js`

Expected: FAIL because diagnostics still split scenario and step resolution.

- [ ] **Step 3: Replace semantic checks with the resolver**

Keep block/quote/table diagnostics and nested-scenario parameter-consistency checks unchanged. The latter may continue reading `ScenarioCatalog` metadata, while call existence and ambiguity come only from the unified resolver. Map `unique` to known, `ambiguous` to a dedicated diagnostic containing source labels, and `missing` to the existing deferred suggestion path. Search candidate display strings from the current view only after debounce/cancellation.

- [ ] **Step 4: Add shared creation code actions**

Return two preferred/non-preferred actions with explicit titles, command IDs, and the seed object. Do not create files inside the provider.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionDiagnostics.test.js out/test/scenarioValidationPolicy.test.js`

Expected: PASS.

```bash
git add src/scenarioDiagnostics.ts src/extension.ts test/projectDefinitionDiagnostics.test.ts
git commit -m "feat: validate unified project definitions"
```

### Task 10: Definition Navigation and Shared Open Command

**Files:**
- Create: `src/projectDefinitionNavigation.ts`
- Create: `test/projectDefinitionNavigation.test.ts`
- Modify: `src/commandHandlers.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.ru.json`

**Interfaces:**
- `ProjectDefinitionProvider implements vscode.DefinitionProvider`
- `openProjectDefinitionHandler(definitionId, resourceUri, resolver)`
- `pickProjectDefinition()` is shared by F12 ambiguity, hover links, and existing open-by-name behavior.

- [ ] **Step 1: Write failing navigation tests**

Assert export title navigation, user implementation preference, registration fallback, nested YAML navigation, no location for built-ins, multiple `LocationLink` results for ambiguity, and a picker that opens the selected stable ID.

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionNavigation.test.js`

Expected: FAIL because the definition provider does not exist.

- [ ] **Step 3: Implement provider and command**

Use the word/invocation range returned by the shared matcher as `originSelectionRange`. Prefer `implementationLocation`, then `definitionLocation`. Register for file-backed `**/*.yaml` and `**/*.feature`. Add `kotTestToolkit.openProjectDefinition` to package contributions and localization.

- [ ] **Step 4: Delegate legacy open-by-name behavior**

Keep `kotTestToolkit.openScenarioByName` for compatibility, but resolve/pick nested definitions through the common navigation helper. Do not rescan the workspace in `navigationUtils.findFileByName()` when a resolver view is available.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionNavigation.test.js out/test/scenarioCatalog.test.js`

Expected: PASS.

```bash
git add src/projectDefinitionNavigation.ts src/commandHandlers.ts src/extension.ts package.json package.nls.json package.nls.ru.json test/projectDefinitionNavigation.test.ts
git commit -m "feat: navigate to project definitions"
```

### Task 11: Lazy Reference Index and VS Code Reference Provider

**Files:**
- Create: `src/projectDefinitionReferences.ts`
- Create: `test/projectDefinitionReferences.test.ts`
- Modify: `src/navigationUtils.ts`
- Modify: `src/commandHandlers.ts`
- Modify: `src/extension.ts`

**Interfaces:**
- `ProjectDefinitionReferenceService.findReferences(definitionId, resource, options, token)`
- `ProjectDefinitionReferenceProvider implements vscode.ReferenceProvider` for YAML, feature, and BSL declarations.
- Search roots are scenario YAML root, active library-root features, and active-profile `FeatureFolder` features.

- [ ] **Step 1: Write failing reference tests**

Cover YAML and feature calls, parameterized templates, same-name stable-ID separation, declaration inclusion flag, open unsaved documents overriding disk, duplicate search-root elimination, one-file cache invalidation, bounded concurrency, and cancellation.

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionReferences.test.js`

Expected: FAIL because the reference service does not exist.

- [ ] **Step 3: Implement lazy per-file usage indexing**

Do no usage scan at activation. On first request enumerate relevant YAML/features, read with bounded concurrency, parse callable lines, and resolve each invocation with the same matcher. Cache by URI/version or size/mtime. Prefer `workspace.textDocuments` content over disk for open documents.

- [ ] **Step 4: Register Shift+F12 and adapt the existing command**

Resolve the definition under the cursor or by a declaration source range, honor `includeDeclaration`, return exact callable ranges, and make `findCurrentFileReferencesHandler` call the same service with cancellable progress. A command started in an export title or user-step BSL declaration therefore uses that stable definition ID rather than its text alone. Preserve the existing Quick Pick presentation for the command.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionReferences.test.js out/test/scenarioReferenceMatcher.test.js`

Expected: PASS.

```bash
git add src/projectDefinitionReferences.ts src/navigationUtils.ts src/commandHandlers.ts src/extension.ts test/projectDefinitionReferences.test.ts
git commit -m "feat: find project definition references"
```

### Task 12: Export Scenario Creation Service and Command

**Files:**
- Create: `src/exportScenarioCreator.ts`
- Create: `test/exportScenarioCreator.test.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.ru.json`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`

**Interfaces:**
- Pure `planExportScenarioEdit(source, request): ExportScenarioEditPlan` validates parser metadata and returns exact edits/cursor.
- UI `createExportScenarioCommand(seed?, services?)` selects active root and existing/new feature, prompts for parameter names, applies `WorkspaceEdit`, and opens the declaration.

- [ ] **Step 1: Write failing edit-planner tests**

Test adding to an existing tagged feature, confirmed addition of a missing tag, refusal when tag confirmation is absent, new RU/EN feature generation, Quick Fix title prefill, quoted-value parameter suggestions, duplicate parameter-name validation, BOM/CRLF/indent/final-newline preservation, and concurrent-version rejection.

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/exportScenarioCreator.test.js`

Expected: FAIL because the creator does not exist.

- [ ] **Step 3: Implement pure edit planning**

Use `parseExportScenarios()` metadata; never search insertion points with a new regex. For new files emit `# language`, `@ExportScenarios`, feature header, scenario header, and one indented blank body line. For existing files return edits against the parsed document version and preserve text conventions exactly.

- [ ] **Step 4: Implement command UI and registration**

Require `ensureReady()` only after explicit invocation. If there are no roots, show one actionable message pointing to active-profile parameters. List existing features containing export scenarios before the create-new option. Add `kotTestToolkit.createExportScenario` to package contributions and both localization systems.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/exportScenarioCreator.test.js out/test/exportScenarioParser.test.js`

Expected: PASS.

```bash
git add src/exportScenarioCreator.ts src/extension.ts package.json package.nls.json package.nls.ru.json l10n/bundle.l10n.json l10n/bundle.l10n.ru.json test/exportScenarioCreator.test.ts
git commit -m "feat: create exported scenarios"
```

### Task 13: Source-first User-step Creation and Explicit EPF Build

**Files:**
- Create: `src/userStepCreator.ts`
- Create: `src/userStepLibraryBuilder.ts`
- Create: `test/userStepCreator.test.ts`
- Create: `test/userStepLibraryBuilder.test.ts`
- Modify: `src/directProcessLaunch.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.ru.json`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`

**Interfaces:**
- `planUserStepSourceEdit(parsed, request): UserStepSourceEditPlan`
- `resolveVanessaTemplateRoot(configuration): string | null`
- `buildUserStepLibrary(request, dependencies, token): Promise<UserStepBuildResult>`
- Commands: `kotTestToolkit.createUserStep` and `kotTestToolkit.buildUserStepLibrary`.

- [ ] **Step 1: Write failing source-creation tests**

Test new layout under `step_definitions-src/<LibraryName>`, Vanessa `lib/TemplateEpfUF` metadata copying, generated `ПолучитьСписокТестов` skeleton, registration/snippet/function generation, safe existing-module insertion, duplicate implementation names, malformed/ambiguous insertion refusal, and successful source creation without a configured 1C platform.

- [ ] **Step 2: Run source-creation tests and verify failure**

Run: `npm run compile-tests && node --test out/test/userStepCreator.test.js`

Expected: FAIL because the creator does not exist.

- [ ] **Step 3: Implement source creation with parser-proven edits**

Resolve Vanessa from active-profile `VanessaFolder`, `VanessaDir`, or `VanessaPath`, then folder containing `kotTestToolkit.runVanessa.vanessaEpfPath`. Validate `lib/TemplateEpfUF` before creating a new library. Copy only the required metadata tree, create KOT's deterministic object-module skeleton, and use `WorkspaceEdit` for existing modules. Open the implementation after success.

The command prompts for target root, new/existing source library, displayed template, ordered parameter names, implementation procedure/function name, description, and category. New sources are written beneath `step_definitions-src/<LibraryName>/`; the build target is always `step_definitions/<LibraryName>.epf` in the same library root.

- [ ] **Step 4: Write failing atomic-build tests**

Inject filesystem, platform picker, startup-infobase provider, process runner, and clock. Assert the exact argument array for an unauthenticated startup infobase, with a second case inserting `/N` and `/P` from the startup-infobase result:

```ts
[
    'DESIGNER',
    '/IBConnectionString', buildFileInfobaseConnectionArgument(startupInfobase, { trailingSemicolon: true }),
    '/LoadExternalDataProcessorOrReportFromFiles', rootXml, temporaryEpf,
    '/DisableStartupDialogs', '/DisableStartupMessages',
    '/Out', logPath
]
```

Also test cancellation, non-zero exit, missing/zero-byte temporary output, successful atomic replacement, and preservation of an existing EPF on every failure.

- [ ] **Step 5: Run the atomic-build test and verify failure**

Run: `npm run compile-tests && node --test out/test/userStepLibraryBuilder.test.js`

Expected: FAIL because `src/userStepLibraryBuilder.ts` does not exist.

- [ ] **Step 6: Implement the explicit builder**

Use `resolveOneCPlatformForLaunch()`, `resolveOneCDesignerExePath()`, and `ensureSharedStartupInfobaseReady()`. Extend `directProcessLaunch.ts` only with a reusable cancellable `spawn` wrapper using `shell: false` and redacted display. Build beside the target under a unique temporary name; stat the result before rename; delete only the temporary artifact on failure; show the log/output channel.

- [ ] **Step 7: Register commands and run tests**

Run: `npm run compile-tests && node --test out/test/userStepCreator.test.js out/test/userStepLibraryBuilder.test.js out/test/directProcessLaunch.test.js`

Expected: PASS.

```bash
git add src/userStepCreator.ts src/userStepLibraryBuilder.ts src/directProcessLaunch.ts src/extension.ts package.json package.nls.json package.nls.ru.json l10n/bundle.l10n.json l10n/bundle.l10n.ru.json test/userStepCreator.test.ts test/userStepLibraryBuilder.test.ts test/directProcessLaunch.test.ts
git commit -m "feat: create and build user step libraries"
```

### Task 14: Activation Wiring and Test Manager Creation Menu

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/phaseSwitcher.ts`
- Modify: `media/phaseSwitcher.html`
- Modify: `media/phaseSwitcher.js`
- Modify: `test/phaseSwitcherWebviewContract.test.ts`
- Modify: `test/extensionActivationContract.test.ts`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`

**Interfaces:**
- One `ProjectDefinitionIndexService`, resolver, navigation provider, and reference service are extension-lifetime dependencies disposed through `context.subscriptions`.
- Test Manager posts `createExportScenario` and `createUserStep`, which dispatch only the shared palette commands.

- [ ] **Step 1: Write failing webview and activation contract tests**

Assert two new menu entries, localized labels, matching click handlers/messages, command dispatch cases, DefinitionProvider and ReferenceProvider registration, background `start()` after registration, and absence of `await projectDefinitionIndexService.ensureReady()` from activation.

- [ ] **Step 2: Run and verify failure**

Run: `npm run compile-tests && node --test out/test/phaseSwitcherWebviewContract.test.js out/test/extensionActivationContract.test.js`

Expected: FAIL because the menu and activation graph are incomplete.

- [ ] **Step 3: Wire services in dependency order**

Construct the index with `YamlParametersManager`, then resolver with index/scenario/step providers, then editor providers and commands. Register all providers before calling `projectDefinitionIndexService.start()`. Dispose watchers, cancellation sources, emitters, and reference caches.

- [ ] **Step 4: Add Test Manager entries**

Place `Export scenario` and `User step` beside main/nested scenario creation. The webview sends messages only; `PhaseSwitcherProvider` calls `vscode.commands.executeCommand()` and contains no creator/scanner logic.

- [ ] **Step 5: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/phaseSwitcherWebviewContract.test.js out/test/extensionActivationContract.test.js`

Expected: PASS.

```bash
git add src/extension.ts src/phaseSwitcher.ts media/phaseSwitcher.html media/phaseSwitcher.js test/phaseSwitcherWebviewContract.test.ts test/extensionActivationContract.test.ts l10n/bundle.l10n.json l10n/bundle.l10n.ru.json
git commit -m "feat: expose project definition workflows"
```

### Task 15: Documentation, Corpus Smoke Test, and Full Verification

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Create: `test/projectDefinitionsCorpus.test.ts`

**Interfaces:**
- Documentation states active-profile behavior, supported source formats, binary-only EPF limitation, creation layouts, build prerequisites, and troubleshooting/cache behavior.

- [ ] **Step 1: Add a read-only corpus smoke test**

The test accepts `KOT_VANESSA_CORPUS` and `KOT_PROJECT_DEFINITION_CORPUS` environment variables and skips each absent corpus. When present, it parses discovered supported `.feature`/`.bsl` files, asserts no parser crash, prints counts/warnings, and never writes outside test temp storage. Unit fixtures remain the required CI coverage.

- [ ] **Step 2: Document behavior and limitations in README and changelog**

Include command names, root precedence, supported export tags/languages, `step_definitions-src` layout, explicit build behavior, and the statement that existing binary-only `.epf` libraries remain unavailable until a later opt-in extraction version.

- [ ] **Step 3: Run focused project-definition suite**

Run:

```bash
npm run compile-tests
node --test out/test/projectDefinitionMatcher.test.js out/test/projectLibraryRoots.test.js out/test/exportScenarioParser.test.js out/test/bslStepSourceParser.test.js out/test/projectDefinitionIndex.test.js out/test/projectDefinitionIndexService.test.js out/test/projectDefinitionResolver.test.js out/test/projectDefinitionEditorProviders.test.js out/test/projectDefinitionDiagnostics.test.js out/test/projectDefinitionNavigation.test.js out/test/projectDefinitionReferences.test.js out/test/exportScenarioCreator.test.js out/test/userStepCreator.test.js out/test/userStepLibraryBuilder.test.js out/test/projectDefinitionsCorpus.test.js
```

Expected: PASS; external corpus test either reports counts or an explicit skip.

- [ ] **Step 4: Run full repository verification**

Run: `npm run check`

Expected: TypeScript, ESLint, and the complete Node test suite pass.

- [ ] **Step 5: Package the extension**

Run: `npx @vscode/vsce package --no-dependencies`

Expected: prepublish verification passes and a versioned `.vsix` is created. Remove the generated `.vsix` from the working tree if it is not already ignored; do not commit package artifacts.

- [ ] **Step 6: Review the diff and commit documentation/tests**

Run: `git diff --check && git status --short`

Expected: no whitespace errors and only intentional tracked changes.

```bash
git add README.md CHANGELOG.md test/projectDefinitionsCorpus.test.ts
git commit -m "docs: describe project step libraries"
```

## Final Acceptance Walkthrough

- [ ] Open a workspace whose active KOT profile points to a library root containing an exported `.feature`; confirm completion and hover appear before any manual refresh.
- [ ] Open a source-backed user-step library; confirm completion, F12 to implementation, Shift+F12, and diagnostics use the same definition.
- [ ] Create same-text definitions in two fixture libraries; confirm both completion entries remain and hover/F12/diagnostics expose ambiguity.
- [ ] Switch the active profile during a deliberately slow scan; confirm only the new profile's definitions appear.
- [ ] Create an export scenario from palette, Quick Fix, and Test Manager; confirm all three reach the same workflow.
- [ ] Create a user step without a configured 1C platform; confirm source succeeds and build remains a separate command.
- [ ] Force Designer build failure with an existing target EPF; confirm the previous binary is byte-for-byte unchanged and the log is visible.
- [ ] Reload the Extension Host; confirm activation and built-in IntelliSense remain responsive while project indexing completes in the background.
