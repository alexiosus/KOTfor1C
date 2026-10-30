# Visual Step Library Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a responsive three-pane visual library for built-in Vanessa steps, user BSL steps, exported Feature scenarios, and nested YAML scenarios, with shared IntelliSense insertion, category editing, and live navigation.

**Architecture:** `ProjectDefinitionResolver` remains the only runtime source of callable definitions. Pure modules enrich catalogs, propagate nested-scenario categories, build serializable presentation models, and construct snippets. A single lazy `StepLibraryPanel` renders local webview assets, performs client-side search, validates every message in the Extension Host, and reuses existing refresh and navigation services.

**Tech Stack:** TypeScript 5.8, Node.js 20 APIs, VS Code 1.98 extension/webview APIs, `yaml` CST support already used by the project, esbuild, Node test runner, GitHub Actions.

**Spec:** `docs/superpowers/specs/2026-09-25-visual-step-library-design.md`

## Global Constraints

- Keep `ProjectDefinitionResolver` as the only runtime source of definitions; the panel must not scan files or parse Vanessa sources.
- Keep `steps.htm`, custom HTML, old schema-v1 JSON catalogs, and exact-version catalog fallback behavior working.
- Do not touch the AI functionality or add EPF unpacking to the Extension Host.
- Keep built-in step IDs stable; category metadata is additive and must not affect IDs.
- Keep `KOTМетаданные.Категория` independent from `KOTМетаданные.PhaseSwitcher.Tab`.
- Preserve BOM, newline style, comments, unrelated metadata, and safe key ordering in YAML edits.
- Build snippets only in the Extension Host. Never send snippet syntax, regexes, VS Code objects, or arbitrary source URIs from the webview.
- Reuse `openProjectDefinitionHandler` for navigation, including its captured-location fallback.
- Search on each keystroke only in the webview. Do not use Levenshtein distance or traverse the catalog in the Extension Host while typing.
- Use one lazy panel instance per Extension Host and discard stale asynchronous loads by generation number.
- Render untrusted definition text through `textContent`; use a restrictive CSP, nonce, local resources, and exhaustive message validation.
- All commits must use `Alexey Eremeev <48015759+alexiosus@users.noreply.github.com>`.

## Review Focus

- Category-only YAML edits must invalidate nested definitions and regroup the open panel without `Reload Window`; pinned by Tasks 1, 2, 6, and 8.
- Static Vanessa category extraction must report dynamic, conflicting, unmatched, and untranslated data without dropping a callable step; pinned by Tasks 3 and 4.
- Old catalogs and HTML fallbacks must remain readable and place uncategorized built-ins under the localized fallback node; pinned by Tasks 4 and 6.
- IntelliSense output must remain byte-for-byte equivalent after snippet extraction, including multiline tables and nested-scenario parameter blocks; pinned by Task 5.
- A stale webview message may neither insert the wrong definition nor open an arbitrary URI; pinned by Tasks 7 and 8.
- Opening and searching a corpus of roughly 2,000 definitions must not trigger workspace I/O or block IntelliSense/diagnostics on Windows/Parallels; pinned by Tasks 6, 7, and 10.

## File Structure

### New source modules

- `src/scenarioCategory.ts` — pure category normalization, collection, action data, and command target validation.
- `src/scenarioCategoryCodeLens.ts` — VS Code CodeLens and Add/Change category workflow.
- `src/stepCatalogCategories.ts` — pure Vanessa registration-to-catalog category enrichment and report data.
- `src/projectDefinitionSnippet.ts` — shared pure display/snippet construction for IntelliSense and panel insertion.
- `src/stepLibraryModel.ts` — pure conversion from resolver view to serializable source/category/item model.
- `src/gherkinInsertionContext.ts` — shared supported-document and cursor-context checks.
- `src/stepLibraryPanel.ts` — singleton panel lifecycle, generation guard, message validation, actions, and subscriptions.

### New webview assets

- `media/stepLibrary.css` — three-pane responsive layout using VS Code theme variables.
- `media/stepLibraryProtocol.js` — UMD-style pure filtering, ranking, category-tree, and state helpers testable from Node.
- `media/stepLibrary.js` — DOM rendering, keyboard interaction, persisted UI state, and bounded result batches.

### New tests

- `test/scenarioCategory.test.ts`
- `test/scenarioCategoryCodeLens.test.ts`
- `test/stepCatalogCategories.test.ts`
- `test/projectDefinitionSnippet.test.ts`
- `test/stepLibraryModel.test.ts`
- `test/stepLibraryProtocol.test.ts`
- `test/stepLibraryPanel.test.ts`
- `test/stepLibraryPanelContract.test.ts`
- `test/gherkinInsertionContext.test.ts`

### Existing files changed

- Scenario data/editing: `src/types.ts`, `src/scenarioDescriptor.ts`, `src/scenarioYamlMutations.ts`, `src/scenarioCreator.ts`, `src/projectDefinitionResolver.ts`.
- Vanessa publication: `src/bslStepSourceParser.ts`, `src/stepCatalog.ts`, `src/stepCatalogTemplateXml.ts`, `tools/step-catalog/cli.ts`, `.github/workflows/publish-step-catalogs.yml`.
- Shared runtime: `src/projectDefinition.ts`, `src/completionProvider.ts`, `src/extension.ts`, `src/phaseSwitcher.ts`, `media/phaseSwitcher.html`, `media/phaseSwitcher.js`.
- Contributions/localization: `package.json`, `package.nls.json`, `package.nls.ru.json`, `l10n/bundle.l10n.json`, `l10n/bundle.l10n.ru.json`.
- Existing regression suites: the corresponding descriptor, YAML, catalog, resolver, completion, activation, and webview contract tests.

---

### Task 1: Nested Scenario Category Contract and CST-safe Mutation

**Files:**
- Modify: `src/types.ts`
- Modify: `src/scenarioDescriptor.ts`
- Modify: `src/scenarioYamlMutations.ts`
- Modify: `src/projectDefinitionResolver.ts`
- Modify: `test/scenarioDescriptor.test.ts`
- Modify: `test/scenarioYamlEdits.test.ts`
- Modify: `test/projectDefinitionResolver.test.ts`

**Interfaces:**

```ts
export interface ParsedScenarioDescriptor {
    readonly scenarioCategory?: string;
}

export interface TestInfo {
    scenarioCategory?: string;
}

export function updateScenarioCategoryInMetadataContent(
    source: string,
    category: string
): ScenarioYamlContentMutation;
```

- [ ] **Step 1: Write failing descriptor and resolver propagation tests**

```ts
test('propagates an independent nested scenario category into the resolver', async () => {
    const descriptor = parseScenarioDescriptor([
        'ДанныеСценария:',
        '    Имя: Создать заказ',
        'KOTМетаданные:',
        '    Категория: "Продажи.Заказы"',
        '    PhaseSwitcher:',
        '        Tab: "Регресс"'
    ].join('\n'));

    assert.equal(descriptor.scenarioCategory, 'Продажи.Заказы');
    assert.equal(descriptor.phaseSwitcher.tabName, 'Регресс');
});
```

Add a resolver test that creates two otherwise-identical scenario catalogs whose only difference is `scenarioCategory`; assert different view identities and `nestedScenario.category === 'Продажи.Заказы'`.

- [ ] **Step 2: Run targeted tests and verify failure**

Run: `npm run compile-tests && node --test out/test/scenarioDescriptor.test.js out/test/projectDefinitionResolver.test.js`

Expected: FAIL because `scenarioCategory` is not parsed or propagated.

- [ ] **Step 3: Parse, copy, and hash the category**

Read `KOTМетаданные.Категория` with `ScenarioYamlDocument.readScalar`, pass it through the existing `trimOptional`, copy it into `TestInfo`, set `ProjectDefinition.category` in `nestedDefinition`, and include it in `scenarioIdentity`:

```ts
const scenarioCategory = trimOptional(yaml.readScalar('KOTМетаданные', 'Категория'));

const signatures = catalog.all.map(scenario => ({
    uri: scenario.yamlFileUri.toString(),
    name: scenario.name,
    parameters: scenario.parameters ?? [],
    description: scenario.scenarioDescription ?? '',
    category: scenario.scenarioCategory ?? ''
}));
```

- [ ] **Step 4: Write failing CST mutation tests**

Cover insertion into an existing metadata mapping, update of a single/double/plain scalar, LF/CRLF, BOM, comments, duplicate `Категория`, non-mapping `KOTМетаданные`, and idempotence:

```ts
test('adds category without changing PhaseSwitcher metadata or comments', () => {
    const source = '\uFEFFKOTМетаданные:\r\n    # keep\r\n    Описание: test\r\n    PhaseSwitcher:\r\n        Tab: Регресс\r\n';
    const result = updateScenarioCategoryInMetadataContent(source, 'Продажи.Заказы');
    assert.equal(result.changed, true);
    assert.match(result.content, /Категория: "Продажи\.Заказы"\r\n/);
    assert.match(result.content, /# keep\r\n/);
    assert.match(result.content, /Tab: Регресс\r\n/);
});

test('rejects duplicate category keys without returning edited text', () => {
    assert.throws(() => updateScenarioCategoryInMetadataContent(
        'KOTМетаданные:\n    Категория: A\n    Категория: B\n',
        'C'
    ), /unambiguous scalar/);
});
```

- [ ] **Step 5: Implement the focused mutation**

Trim and reject an empty category. For an existing field, use its `valueRange`; preserve single-quoted, double-quoted, or safe plain style. For an absent field, use `getSectionInsertion(source, 'KOTМетаданные', `Категория: ${JSON.stringify(value)}`)`. Always call `requireValidForEdit()` before and after editing.

```ts
function formatCategoryScalar(source: string, field: ScenarioYamlField, value: string): string {
    const raw = source.slice(field.valueRange!.start, field.valueRange!.end);
    if (raw.startsWith("'")) {
        return `'${value.replace(/'/g, "''")}'`;
    }
    if (raw.startsWith('"')) {
        return JSON.stringify(value);
    }
    return /^[\p{L}\p{N}_ .\/-]+$/u.test(value) ? value : JSON.stringify(value);
}
```

- [ ] **Step 6: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/scenarioDescriptor.test.js out/test/scenarioYamlEdits.test.js out/test/projectDefinitionResolver.test.js`

Expected: PASS.

```bash
git add src/types.ts src/scenarioDescriptor.ts src/scenarioYamlMutations.ts src/projectDefinitionResolver.ts test/scenarioDescriptor.test.ts test/scenarioYamlEdits.test.ts test/projectDefinitionResolver.test.ts
git commit -m "feat: add nested scenario categories"
```

### Task 2: Nested Category CodeLens and Creation Workflow

**Files:**
- Create: `src/scenarioCategory.ts`
- Create: `src/scenarioCategoryCodeLens.ts`
- Create: `test/scenarioCategory.test.ts`
- Create: `test/scenarioCategoryCodeLens.test.ts`
- Modify: `src/scenarioCreator.ts`
- Modify: `src/extension.ts`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.ru.json`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`
- Modify: `test/extensionActivationContract.test.ts`

**Interfaces:**

```ts
export const SCENARIO_CATEGORY_COMMAND = 'kotTestToolkit.setScenarioCategory';

export interface ScenarioCategoryCommandTarget {
    readonly documentUri: string;
    readonly documentVersion: number;
}

export function collectNestedScenarioCategories(
    definitions: readonly Pick<ProjectDefinition, 'kind' | 'category'>[]
): readonly string[];

export function buildScenarioCategoryAction(
    source: string,
    documentUri: string,
    documentVersion: number,
    translate?: Translator
): ScenarioCategoryAction | null;

export function applyScenarioCategoryToTemplate(
    template: string,
    category: string | undefined
): ScenarioYamlContentMutation;
```

- [ ] **Step 1: Write failing pure action/category tests**

```ts
test('collects nested categories case-insensitively and preserves authored spelling', () => {
    assert.deepEqual(collectNestedScenarioCategories([
        { kind: 'nestedScenario', category: 'Продажи.Заказы' },
        { kind: 'nestedScenario', category: 'продажи.заказы' },
        { kind: 'exportScenario', category: 'Exports' }
    ]), ['Продажи.Заказы']);
});

test('builds Add or Change category action on KOT metadata', () => {
    assert.equal(buildScenarioCategoryAction(
        'KOTМетаданные:\n    Описание: test\n', 'file:///a.yaml', 4
    )?.title, '+ Category');
    assert.equal(buildScenarioCategoryAction(
        'KOTМетаданные:\n    Категория: Existing\n', 'file:///a.yaml', 4
    )?.title, 'Change category');
});
```

- [ ] **Step 2: Run tests and verify missing-module failure**

Run: `npm run compile-tests && node --test out/test/scenarioCategory.test.js out/test/scenarioCategoryCodeLens.test.js`

Expected: FAIL because the category workflow modules do not exist.

- [ ] **Step 3: Implement pure helpers and VS Code provider**

Mirror the proven export-metadata chooser: resolve existing categories from `ProjectDefinitionResolver.getView(document.uri)`, offer sorted existing values plus `$(add) Create new category…`, allow free text, validate single-line non-empty input, recheck URI/version, and apply a `WorkspaceEdit` containing the full CST-safe mutation result.

```ts
export class ScenarioCategoryCodeLensProvider implements vscode.CodeLensProvider {
    async provideCodeLenses(document: vscode.TextDocument): Promise<vscode.CodeLens[]> {
        const action = buildScenarioCategoryAction(
            document.getText(), document.uri.toString(), document.version, this.translate
        );
        return action ? [new vscode.CodeLens(toVsRange(action.range), {
            title: action.title,
            command: action.command,
            arguments: [action.target]
        })] : [];
    }
}
```

- [ ] **Step 4: Write failing nested-scenario creation tests**

Test `applyScenarioCategoryToTemplate` so nested scenario generation includes an optional category exactly once:

```ts
assert.match(rendered, /KOTМетаданные:\r?\n    Категория: "Продажи\.Заказы"/);
assert.doesNotMatch(renderedWithoutCategory, /Категория:/);
```

- [ ] **Step 5: Add the category prompt to nested-scenario creation**

Create `promptScenarioCategory(existingCategories, initialValue, t)` for `handleCreateNestedScenario`. It must accept an empty result as “no category”, show existing nested categories from the current resolver view, and keep free-text creation. Pass the chosen value through `applyScenarioCategoryToTemplate` after managed header defaults are applied. Main-scenario creation remains unchanged because main scenarios are not callable definitions in this library.

- [ ] **Step 6: Register CodeLens, command, and localization**

Register the provider for YAML scenario documents and the internal command during activation. Contribute the command with `"when": "false"` in `menus.commandPalette`; add exact RU/EN runtime strings for Add category, Change category, chooser titles, validation errors, stale document, and edit failure.

- [ ] **Step 7: Run tests and commit**

Run: `npm run compile-tests && node --test out/test/scenarioCategory.test.js out/test/scenarioCategoryCodeLens.test.js out/test/extensionActivationContract.test.js`

Expected: PASS.

```bash
git add src/scenarioCategory.ts src/scenarioCategoryCodeLens.ts src/scenarioCreator.ts src/extension.ts package.json package.nls.json package.nls.ru.json l10n/bundle.l10n.json l10n/bundle.l10n.ru.json test/scenarioCategory.test.ts test/scenarioCategoryCodeLens.test.ts test/extensionActivationContract.test.ts
git commit -m "feat: edit nested scenario categories"
```

### Task 3: Reusable Static BSL Registration Parser

**Files:**
- Modify: `src/bslStepSourceParser.ts`
- Modify: `test/bslStepSourceParser.test.ts`

**Interfaces:**

```ts
export interface StaticBslStepRegistration {
    readonly snippet: string;
    readonly implementationName: string;
    readonly template: string;
    readonly description: string;
    readonly category?: string;
    readonly range: ProjectDefinitionRange;
}

export interface StaticBslStepRegistrationParseResult {
    readonly registrations: readonly StaticBslStepRegistration[];
    readonly warnings: readonly ProjectDefinitionWarning[];
    readonly declarations: readonly BslDeclaration[];
    readonly registrationInsertionRange: ProjectDefinitionRange | null;
    readonly moduleAppendRange: ProjectDefinitionRange | null;
}

export function parseStaticBslStepRegistrations(
    source: string,
    sourceUri?: string
): StaticBslStepRegistrationParseResult;
```

- [ ] **Step 1: Write failing extraction tests**

```ts
test('extracts static Vanessa registration category from the sixth argument', () => {
    const parsed = parseStaticBslStepRegistrations(`
Процедура ПолучитьСписокТестов(Контекст)
    ДобавитьШагВМассивТестов(Контекст, "And %1 Name", "Run", "And \\"%1 Name\\"", "Description", "UI.Forms");
КонецПроцедуры`);
    assert.deepEqual(parsed.registrations.map(item => ({
        template: item.template,
        category: item.category
    })), [{ template: 'And "%1 Name"', category: 'UI.Forms' }]);
});
```

Also pin concatenated static variables, RU/EN keywords, missing sixth argument, dynamic category warning, malformed strings, and unchanged insertion ranges.

- [ ] **Step 2: Run the parser test and verify failure**

Run: `npm run compile-tests && node --test out/test/bslStepSourceParser.test.js`

Expected: FAIL because only `parseUserStepSource` exposes registrations indirectly.

- [ ] **Step 3: Extract the pure parser without duplicating tokenization**

Move the existing registration loop into `parseStaticBslStepRegistrations`. Keep `scanBslTokens`, static-variable evaluation, warning ranges, declaration detection, and safe insertion ranges unchanged. Then map the pure records to project definitions in `parseUserStepSource`:

```ts
const parsed = parseStaticBslStepRegistrations(source, context.sourceUri);
const definitions = parsed.registrations.map(registration => createUserStepDefinition(
    registration,
    parsed.declarations,
    context
));
return Object.freeze({ ...parsed, definitions });
```

Do not import `vscode` or filesystem APIs.

- [ ] **Step 4: Run existing and new parser tests and commit**

Run: `npm run compile-tests && node --test out/test/bslStepSourceParser.test.js out/test/projectDefinitionResolver.test.js`

Expected: PASS with existing user-step definition IDs, locations, warnings, and creator insertion ranges unchanged.

```bash
git add src/bslStepSourceParser.ts test/bslStepSourceParser.test.ts
git commit -m "refactor: expose static BSL step registrations"
```

### Task 4: Enrich Published Vanessa Catalogs with Categories

**Files:**
- Modify: `src/stepCatalog.ts`
- Create: `src/stepCatalogCategories.ts`
- Modify: `src/stepCatalogTemplateXml.ts`
- Modify: `tools/step-catalog/cli.ts`
- Modify: `.github/workflows/publish-step-catalogs.yml`
- Modify: `test/stepCatalog.test.ts`
- Create: `test/stepCatalogCategories.test.ts`
- Modify: `test/stepCatalogGenerator.test.ts`
- Modify: `test/stepCatalogWorkflowContract.test.ts`

**Interfaces:**

```ts
export interface StepCategoryPath {
    readonly ru?: readonly string[];
    readonly en?: readonly string[];
}

export interface BuiltInStepDefinition {
    readonly id: string;
    readonly ru?: StepTextVariant;
    readonly en?: StepTextVariant;
    readonly categoryPath?: StepCategoryPath;
}

export interface StepCategoryEnrichmentReport {
    readonly categorizedStepCount: number;
    readonly uncategorizedStepCount: number;
    readonly unmatchedRegistrationCount: number;
    readonly conflictingCategoryMappings: readonly string[];
    readonly untranslatableCategorySegments: readonly string[];
}
```

- [ ] **Step 1: Write failing optional-field compatibility tests**

```ts
test('parses optional localized category paths without changing the step id', () => {
    const catalog = parseBuiltInStepCatalog({
        ...validCatalog,
        steps: [{
            ...validCatalog.steps[0],
            categoryPath: { ru: ['Интерфейс', 'Формы'], en: ['UI', 'Forms'] }
        }]
    });
    assert.deepEqual(catalog.steps[0].categoryPath?.en, ['UI', 'Forms']);
    assert.equal(catalog.steps[0].id, validCatalog.steps[0].id);
});

test('continues to parse a schema-v1 catalog without categoryPath', () => {
    assert.equal(parseBuiltInStepCatalog(validCatalog).steps[0].categoryPath, undefined);
});
```

Reject empty segments, non-string entries, empty localized paths, and objects with neither RU nor EN.

- [ ] **Step 2: Run catalog tests and verify failure**

Run: `npm run compile-tests && node --test out/test/stepCatalog.test.js`

Expected: FAIL because the parser currently drops `categoryPath`.

- [ ] **Step 3: Implement additive schema-v1 parsing and serialization**

Add `parseCategoryPath` and return the validated field from `parseBuiltInStepCatalog`. Keep `createStepDefinitionId` unchanged and retain `schemaVersion: 1`.

- [ ] **Step 4: Write failing enrichment tests for every conflict rule**

```ts
test('enriches by normalized Russian template and translates dotted path segments', () => {
    const result = enrichStepCatalogCategories({
        steps: [step('И открываю форму', 'And I open form')],
        categoryTranslations: [
            { ru: 'Интерфейс.Формы', en: 'UI.Forms' }
        ],
        registrations: [registration('И открываю форму', 'Интерфейс.Формы')]
    });
    assert.deepEqual(result.steps[0].categoryPath, {
        ru: ['Интерфейс', 'Формы'],
        en: ['UI', 'Forms']
    });
});

test('leaves a conflicting mapping uncategorized and reports it', () => {
    const result = enrichStepCatalogCategories({
        steps: [step('И шаг')],
        categoryTranslations: [],
        registrations: [registration('И шаг', 'A'), registration('И шаг', 'B')]
    });
    assert.equal(result.steps[0].categoryPath, undefined);
    assert.deepEqual(result.report.conflictingCategoryMappings, ['И шаг']);
});
```

Add repeated-identical, dynamic/skipped, unmatched registration, untranslatable segment, and “no step dropped” cases.

- [ ] **Step 5: Implement pure deterministic enrichment**

Normalize templates with `normalizeStepCatalogText`, split categories on `.`, trim and discard empty segments, collapse identical mappings, and leave conflicts uncategorized. Build translation pairs by splitting each RU/EN category row positionally; record missing/conflicting translations instead of inventing text. Sort every report list deterministically.

- [ ] **Step 6: Add bounded source enumeration to the publication CLI**

Recursively enumerate `.bsl` files below the downloaded Vanessa source root. Before reading/tokenizing a candidate as BSL, perform a case-insensitive byte/text check for `ДобавитьШагВМассивТестов`. Parse matching files with `parseStaticBslStepRegistrations`, pass registrations to `enrichStepCatalogCategories`, and write the new counters/lists into the generation report.

The CLI contract becomes:

```text
generate --source-root <unpacked Vanessa root> --version <X.Y.Z.W> --ref <ref> --commit <sha> --timestamp <iso> --output <dir>
```

Keep the exact `locales/Steps/Templates/en/Ext/Template.xml` lookup under that root.

- [ ] **Step 7: Update workflow and generator contract tests**

Pass the already downloaded official source directory as `--source-root`; assert the workflow does not download a second archive or invoke 1C. Assert reports contain all five category coverage fields and that publication still occurs only after validation.

- [ ] **Step 8: Run catalog/workflow suites and commit**

Run: `npm run compile-tests && node --test out/test/stepCatalog.test.js out/test/stepCatalogCategories.test.js out/test/stepCatalogGenerator.test.js out/test/stepCatalogWorkflowContract.test.js`

Expected: PASS; old fixtures stay valid and enriched fixtures round-trip deterministically.

```bash
git add src/stepCatalog.ts src/stepCatalogCategories.ts src/stepCatalogTemplateXml.ts tools/step-catalog/cli.ts .github/workflows/publish-step-catalogs.yml test/stepCatalog.test.ts test/stepCatalogCategories.test.ts test/stepCatalogGenerator.test.ts test/stepCatalogWorkflowContract.test.ts
git commit -m "feat: publish Vanessa step categories"
```

### Task 5: Shared Definition Snippet and Display Builder

**Files:**
- Create: `src/projectDefinitionSnippet.ts`
- Create: `test/projectDefinitionSnippet.test.ts`
- Modify: `src/completionProvider.ts`
- Modify: `test/projectDefinitionEditorProviders.test.ts`
- Modify: `test/completionMultilinePreview.test.ts`

**Interfaces:**

```ts
export interface ProjectDefinitionSnippetData {
    readonly displayText: string;
    readonly snippetText: string;
    readonly hasPlaceholders: boolean;
}

export interface ProjectDefinitionInsertionOptions {
    readonly preferredText?: string;
    readonly typedKeyword?: string;
    readonly fallbackKeyword: string;
    readonly indentation?: string;
    readonly language: 'ru' | 'en';
    readonly parameterDefaults?: Readonly<Record<string, string>>;
}

export function buildCallableDefinitionText(
    preferredText: string,
    typedKeyword: string,
    fallbackKeyword: string
): string;

export function buildProjectDefinitionSnippetData(
    definition: ProjectDefinition,
    options?: Pick<ProjectDefinitionInsertionOptions, 'preferredText'>
): ProjectDefinitionSnippetData;

export function buildProjectDefinitionInsertion(
    definition: ProjectDefinition,
    options: ProjectDefinitionInsertionOptions
): ProjectDefinitionSnippetData;
```

- [ ] **Step 1: Write characterization tests before moving code**

Pin `%N Hint` placeholders, quotes, dollar/braces/backslashes, outline parameters, export `usageExample`, nested defaults/alignment, keyword replacement, and multiline tables:

```ts
test('preserves a multiline Vanessa step as a snippet', () => {
    const result = buildProjectDefinitionSnippetData(definition({
        template: 'Then table contains rows\n    | "%1 Column" |'
    }));
    assert.equal(result.displayText, 'Then table contains rows\n    | "" |');
    assert.equal(result.snippetText, 'Then table contains rows\n    | "${1}" |');
});

test('builds nested parameter block with defaults', () => {
    const result = buildProjectDefinitionInsertion(nestedDefinition(), {
        fallbackKeyword: 'And', language: 'en'
    });
    assert.equal(result.snippetText,
        'And Create indicator\n    Filters = ${1:"Filters"}\n    Title   = ${2:"Sales"}');
});
```

- [ ] **Step 2: Run the new test and verify missing-module failure**

Run: `npm run compile-tests && node --test out/test/projectDefinitionSnippet.test.js`

Expected: FAIL because the builder is private to `completionProvider.ts`.

- [ ] **Step 3: Extract the implementation as pure functions**

Move `escapeStepSnippetText`, `buildStepTemplateSnippetData`, `escapeSnippetPlaceholderDefault`, `buildProjectDefinitionSnippetData`, and `buildCallableDefinitionText`. Move nested-scenario block generation into `buildProjectDefinitionInsertion`; return strings only and construct `vscode.SnippetString` at the caller boundary.

- [ ] **Step 4: Replace all completion-provider copies**

Use the shared builder for prepared items, semantic completion, export scenarios, nested scenarios, and multiline/block steps. Remove the private equivalents. Do not alter sorting, filtering, documentation, or completion ranges.

- [ ] **Step 5: Run focused and full completion tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionSnippet.test.js out/test/projectDefinitionEditorProviders.test.js out/test/completionMultilinePreview.test.js`

Expected: PASS with existing IntelliSense snapshots/expectations unchanged.

```bash
git add src/projectDefinitionSnippet.ts src/completionProvider.ts test/projectDefinitionSnippet.test.ts test/projectDefinitionEditorProviders.test.ts test/completionMultilinePreview.test.ts
git commit -m "refactor: share project definition snippets"
```

### Task 6: Serializable Step Library Model and Client-side Search

**Files:**
- Modify: `src/projectDefinition.ts`
- Modify: `src/projectDefinitionResolver.ts`
- Create: `src/stepLibraryModel.ts`
- Create: `media/stepLibraryProtocol.js`
- Create: `test/stepLibraryModel.test.ts`
- Create: `test/stepLibraryProtocol.test.ts`
- Modify: `test/projectDefinitionResolver.test.ts`

**Interfaces:**

```ts
export type StepLibrarySourceGroup = 'builtIn' | 'user' | 'export' | 'nested';

export interface StepLibraryItem {
    readonly id: string;
    readonly definitionId: string;
    readonly familyId: string;
    readonly kind: ProjectDefinitionKind;
    readonly sourceGroup: StepLibrarySourceGroup;
    readonly template: string;
    readonly displayText: string;
    readonly alternateDisplayText?: string;
    readonly language?: 'ru' | 'en';
    readonly description?: string;
    readonly categoryPath: readonly string[];
    readonly parameters: readonly StepLibraryParameter[];
    readonly sourceLabel: string;
    readonly navigable: boolean;
    readonly capturedLocation?: ProjectDefinitionLocation;
    readonly searchText: string;
}

export interface StepLibrarySnapshot {
    readonly viewIdentity: string;
    readonly items: readonly StepLibraryItem[];
    readonly counts: Readonly<Record<StepLibrarySourceGroup, number>>;
}

export function buildStepLibrarySnapshot(view: ProjectDefinitionView): StepLibrarySnapshot;
```

- [ ] **Step 1: Write failing resolver family/category tests**

Assert paired built-in RU/EN definitions share `familyId === step.id`, receive their localized `categoryPath`, and retain IDs `${step.id}:ru/en`. Assert catalogs without category metadata still produce definitions with no category path.

- [ ] **Step 2: Extend only the presentation-facing project contract**

Add optional `familyId?: string` and `categoryPath?: readonly string[]` to `ProjectDefinition`. `builtInVariant` selects `step.categoryPath?.[language]`, freezes a copy, and sets `familyId: step.id`. Project categories are split later, not stored twice.

- [ ] **Step 3: Write failing model tests for all four roots**

```ts
test('builds stable serializable rows for all callable sources', () => {
    const snapshot = buildStepLibrarySnapshot(viewWithFourKinds());
    assert.deepEqual(snapshot.counts, { builtIn: 2, user: 1, export: 1, nested: 1 });
    assert.deepEqual(
        snapshot.items.find(item => item.kind === 'nestedScenario')?.categoryPath,
        ['Продажи', 'Заказы']
    );
    assert.equal(JSON.parse(JSON.stringify(snapshot)).viewIdentity, snapshot.viewIdentity);
});
```

Pin stable item IDs, alternate built-in translation, multiline display text, navigable locations, empty `Uncategorized` path, deterministic ordering, and normalized search text.

- [ ] **Step 4: Implement the pure snapshot builder**

Pair built-ins by `familyId`; emit one item per language variant so RU/EN/Both remains selectable, but attach the alternate display text. Split authored user/export/nested categories on `.`, trim empty segments, and preserve spelling. Use `buildProjectDefinitionSnippetData` for `displayText`. Never include snippet text.

- [ ] **Step 5: Write failing protocol tests**

`media/stepLibraryProtocol.js` must export under Node and attach to `globalThis.StepLibraryProtocol` in a webview. Test deterministic ranking:

```js
const ranked = protocol.searchItems(items, 'open form');
assert.deepEqual(ranked.map(item => item.id), [
    'exact-template', 'template-prefix', 'token-prefix', 'template-substring', 'metadata-substring'
]);
```

Also test source/category filtering, RU/EN/Both behavior that never hides project definitions, category counts, ancestor matching, stable alphabetical ties, and no `levenshtein`/matrix implementation.

- [ ] **Step 6: Implement pure client protocol**

Precompute lowercase NFC strings in the Extension Host. In the protocol, tokenize the query once, assign rank buckets 0–4, compare alphabetically on ties, and return a sliced result window. Build tree nodes from source roots plus category segments, using a localized uncategorized label only for display.

- [ ] **Step 7: Run model/protocol tests and commit**

Run: `npm run compile-tests && node --test out/test/projectDefinitionResolver.test.js out/test/stepLibraryModel.test.js out/test/stepLibraryProtocol.test.js`

Expected: PASS.

```bash
git add src/projectDefinition.ts src/projectDefinitionResolver.ts src/stepLibraryModel.ts media/stepLibraryProtocol.js test/projectDefinitionResolver.test.ts test/stepLibraryModel.test.ts test/stepLibraryProtocol.test.ts
git commit -m "feat: build visual step library model"
```

### Task 7: Read-only Three-pane Panel and Refresh Lifecycle

**Files:**
- Create: `src/stepLibraryPanel.ts`
- Create: `media/stepLibrary.css`
- Create: `media/stepLibrary.js`
- Create: `test/stepLibraryPanel.test.ts`
- Create: `test/stepLibraryPanelContract.test.ts`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`

**Interfaces:**

```ts
export interface StepLibraryPanelServices {
    readonly extensionUri: vscode.Uri;
    readonly resolver: ProjectDefinitionResolver;
    readonly refreshDefinitions: (resource?: vscode.Uri) => Promise<void>;
}

export type StepLibraryInboundMessage =
    | { readonly command: 'ready' }
    | { readonly command: 'refresh' }
    | { readonly command: 'insert'; readonly itemId: string }
    | { readonly command: 'copy'; readonly itemId: string }
    | { readonly command: 'openDefinition'; readonly itemId: string };

export class StepLibraryPanel implements vscode.Disposable {
    open(resource?: vscode.Uri): Promise<void>;
    dispose(): void;
}
```

- [ ] **Step 1: Write failing generation/lifecycle unit tests**

Use injected resolver/webview fakes. Start two deferred loads, resolve the older one last, and assert only the newer snapshot is posted. Assert equal `viewIdentity + insertionTargetIdentity` is not reposted, resolver change schedules a refresh, hidden panel defers work, visible panel refreshes, and failure retains the last successful snapshot.

- [ ] **Step 2: Write failing static security/asset contract tests**

Assert:

- panel HTML has `default-src 'none'`, nonce script, local styles, and no remote URLs;
- all three media files exist and are packaged;
- `stepLibrary.js` renders definition values with `textContent` and never assigns definition data to `innerHTML`;
- incoming message parsing accepts only the five commands and non-empty `itemId` where required;
- no arbitrary URI exists in an inbound message type.

- [ ] **Step 3: Implement the lazy panel shell and generation guard**

Create the webview with scripts enabled, `localResourceRoots: [mediaUri]`, one nonce per HTML render, and retained context only while the panel exists. Increment `loadGeneration` before each `resolver.getView(resource)`, compare after await, build a snapshot, and post only current state.

```ts
const generation = ++this.loadGeneration;
const view = await this.services.resolver.getView(resource);
if (generation !== this.loadGeneration || !this.panel) {
    return;
}
const snapshot = buildStepLibrarySnapshot(view);
await this.postSnapshotIfChanged(snapshot, this.insertionTarget);
```

- [ ] **Step 4: Implement three-pane rendering and persisted state**

Use CSS grid for category/list/details panes; at narrow widths show details as an explicit view and collapse categories behind a toolbar button. Persist query, source/category, expanded nodes, selected item, language filter, and sort mode through `getState/setState`. Render at most 100 rows initially and append bounded batches with `requestAnimationFrame`.

- [ ] **Step 5: Implement keyboard and accessible browsing**

Give the tree and list proper roles/labels. Support arrows, Home/End, Enter, Escape/back, and focus transitions. Single click selects; double click/Enter sends insert (the action remains disabled until Task 8 supplies a valid target). Display loading, empty catalog, no results, fallback/uncategorized, partial warning, refresh failure, and unavailable target states.

- [ ] **Step 6: Subscribe only to existing change sources**

Subscribe to `resolver.onDidChangeView`, panel visibility, active editor/selection, and relevant profile/catalog configuration events supplied from activation. Do not add file watchers or scans. Dispose all subscriptions with the panel.

- [ ] **Step 7: Run panel tests and commit**

Run: `npm run compile-tests && node --test out/test/stepLibraryPanel.test.js out/test/stepLibraryPanelContract.test.js out/test/stepLibraryProtocol.test.js`

Expected: PASS.

```bash
git add src/stepLibraryPanel.ts media/stepLibrary.css media/stepLibrary.js l10n/bundle.l10n.json l10n/bundle.l10n.ru.json test/stepLibraryPanel.test.ts test/stepLibraryPanelContract.test.ts
git commit -m "feat: add visual step library panel"
```

### Task 8: Safe Insert, Copy, and Open-definition Actions

**Files:**
- Create: `src/gherkinInsertionContext.ts`
- Create: `test/gherkinInsertionContext.test.ts`
- Modify: `src/completionProvider.ts`
- Modify: `src/stepLibraryPanel.ts`
- Modify: `test/stepLibraryPanel.test.ts`
- Modify: `test/projectDefinitionEditorProviders.test.ts`
- Modify: `test/completionMultilinePreview.test.ts`
- Modify: `test/projectDefinitionNavigation.test.ts`

**Interfaces:**

```ts
export interface GherkinInsertionContext {
    readonly supported: boolean;
    readonly language: 'ru' | 'en';
    readonly fallbackKeyword: string;
    readonly typedKeyword: string;
    readonly indentation: string;
}

export function getGherkinInsertionContext(
    document: Pick<vscode.TextDocument, 'uri' | 'languageId' | 'lineAt' | 'getText'>,
    position: vscode.Position
): GherkinInsertionContext | null;
```

- [ ] **Step 1: Write failing context tests**

Cover `.feature`, YAML inside `ТекстСценария` block scalar, YAML metadata/outside block, unsupported files, RU/EN keyword inference, indentation, blank lines, stale positions, and multiline selections.

- [ ] **Step 2: Extract the context check and keep completion behavior unchanged**

Move the supported-document and scenario-text-block checks out of `DriveCompletionProvider`; make both IntelliSense and the panel use them. Keep variable/parameter completion branches unchanged.

- [ ] **Step 3: Write failing panel action tests**

Assert:

- focusing the webview still inserts into the last captured eligible editor;
- changed document version causes revalidation before insertion;
- unsupported/stale target performs no edit;
- item ID is resolved against the current snapshot/view, not trusted message data;
- copy writes `displayText`, never snippet syntax;
- open-definition calls `openProjectDefinitionHandler(definitionId, resource, resolver, capturedLocation)`;
- a removed definition can open only its captured valid location;
- a built-in item has no open action.

- [ ] **Step 4: Track and revalidate the insertion target**

Capture editor URI, document version, selections, and context whenever an eligible text editor is active. When the panel receives `insert`, find the presentation item by `itemId`, load the current resolver view, resolve `definitionId`, revalidate the current document and selections, then construct the shared insertion.

```ts
const insertion = buildProjectDefinitionInsertion(definition, {
    preferredText: definition.kind === 'exportScenario'
        ? definition.usageExample ?? definition.template
        : definition.template,
    typedKeyword: target.context.typedKeyword,
    fallbackKeyword: target.context.fallbackKeyword,
    indentation: target.context.indentation,
    language: target.context.language
});
await editor.insertSnippet(new vscode.SnippetString(insertion.snippetText), selections);
```

- [ ] **Step 5: Implement copy and navigation with validated IDs**

Copy the current item’s plain `displayText` through `vscode.env.clipboard.writeText`. For navigation, use the definition ID plus the captured location already present in the server-created item; do not accept a URI from the message.

- [ ] **Step 6: Add webview action wiring**

Enable Insert only when the latest server state says the target is valid. Wire double-click and Enter to insert, Ctrl/Cmd+C to copy, and the details action to open definition. Suppress duplicate messages while the same action is pending and announce results through an ARIA live region.

- [ ] **Step 7: Run action/completion/navigation tests and commit**

Run: `npm run compile-tests && node --test out/test/gherkinInsertionContext.test.js out/test/stepLibraryPanel.test.js out/test/projectDefinitionEditorProviders.test.js out/test/completionMultilinePreview.test.js out/test/projectDefinitionNavigation.test.js`

Expected: PASS.

```bash
git add src/gherkinInsertionContext.ts src/completionProvider.ts src/stepLibraryPanel.ts media/stepLibrary.js test/gherkinInsertionContext.test.ts test/stepLibraryPanel.test.ts test/projectDefinitionEditorProviders.test.ts test/completionMultilinePreview.test.ts test/projectDefinitionNavigation.test.ts
git commit -m "feat: add step library actions"
```

### Task 9: Command Palette, Editor, and Test Manager Entry Points

**Files:**
- Modify: `src/extension.ts`
- Modify: `src/phaseSwitcher.ts`
- Modify: `media/phaseSwitcher.html`
- Modify: `media/phaseSwitcher.js`
- Modify: `package.json`
- Modify: `package.nls.json`
- Modify: `package.nls.ru.json`
- Modify: `l10n/bundle.l10n.json`
- Modify: `l10n/bundle.l10n.ru.json`
- Modify: `test/extensionActivationContract.test.ts`
- Modify: `test/phaseSwitcherWebviewContract.test.ts`
- Modify: `test/stepLibraryPanelContract.test.ts`

**Commands:**

```text
kotTestToolkit.openStepLibrary
kotTestToolkit.setScenarioCategory
```

- [ ] **Step 1: Write failing contribution and lazy-activation contracts**

Assert `openStepLibrary` is contributed with localized title/category, appears in Command Palette, and appears in `editor/title` only for `.yaml` or `.feature`. Assert activation uses a lazy dynamic import and passes the existing resolver/refresh services rather than constructing a new index or scanner.

- [ ] **Step 2: Register one lazy panel instance**

Keep a module-level promise/instance inside `activate`:

```ts
let stepLibraryPanel: StepLibraryPanel | undefined;
async function getStepLibraryPanel(): Promise<StepLibraryPanel> {
    if (!stepLibraryPanel) {
        const { StepLibraryPanel } = await import('./stepLibraryPanel.js');
        stepLibraryPanel = new StepLibraryPanel({
            extensionUri: context.extensionUri,
            resolver: projectDefinitionResolver,
            refreshDefinitions: async resource => {
                await stepCatalogService.refresh(resource);
                await projectDefinitionIndex.reloadConfigurations();
                await projectDefinitionIndex.waitForIdle();
                await phaseSwitcherProvider.refreshFromExternalStateChange({ refreshCache: true });
            }
        });
        context.subscriptions.push(stepLibraryPanel);
    }
    return stepLibraryPanel;
}
```

The command calls `open` with the active editor resource when available.

- [ ] **Step 3: Add Test Manager action and protocol handling**

Add a Step Library toolbar/menu button using Codicons. `phaseSwitcher.js` posts `{ command: 'openStepLibrary' }`; `PhaseSwitcherProvider` validates the exact command and executes `kotTestToolkit.openStepLibrary`. Add RU/EN title/hint fields to the existing localized dictionary.

- [ ] **Step 4: Add all package and runtime localization**

Provide matching English/Russian strings for command title, panel title, source roots, uncategorized, filters, details labels, actions, loading/error/empty states, fallback warning, insertion target state, category workflow, and Test Manager tooltip. Contract tests must compare key sets between locale files.

- [ ] **Step 5: Run integration contracts and commit**

Run: `npm run compile-tests && node --test out/test/extensionActivationContract.test.js out/test/phaseSwitcherWebviewContract.test.js out/test/stepLibraryPanelContract.test.js`

Expected: PASS.

```bash
git add src/extension.ts src/phaseSwitcher.ts media/phaseSwitcher.html media/phaseSwitcher.js package.json package.nls.json package.nls.ru.json l10n/bundle.l10n.json l10n/bundle.l10n.ru.json test/extensionActivationContract.test.ts test/phaseSwitcherWebviewContract.test.ts test/stepLibraryPanelContract.test.ts
git commit -m "feat: expose visual step library"
```

### Task 10: Full Verification, Packaging, and Performance Evidence

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `docs/superpowers/specs/2026-09-25-visual-step-library-design.md` only if implementation decisions require wording corrections
- Modify: tests or source files only for defects discovered by this task

- [ ] **Step 1: Run a placeholder and unsafe-render scan**

Run:

```bash
rg -n "TODO|TBD|FIXME|PLACEHOLDER|innerHTML\s*=|eval\(|new Function" src/stepLibraryPanel.ts src/stepLibraryModel.ts src/scenarioCategory.ts media/stepLibrary.js media/stepLibraryProtocol.js
```

Expected: no implementation placeholders, executable-string APIs, or definition-data `innerHTML` assignments. A static initial shell assignment is permitted only if the contract test proves all data uses DOM/text nodes.

- [ ] **Step 2: Run all automated checks**

Run:

```bash
npm run check
git diff --check
```

Expected: TypeScript checks, ESLint, and the complete Node test suite PASS; `git diff --check` emits nothing.

- [ ] **Step 3: Build the production package**

Run:

```bash
npm run vscode:prepublish
npx vsce package
```

Expected: production bundle and VSIX build successfully; the VSIX contains `media/stepLibrary.css`, `media/stepLibrary.js`, and `media/stepLibraryProtocol.js`.

- [ ] **Step 4: Measure the prepared-view hot path**

Add a test fixture with at least 2,000 definitions and record:

- one `buildStepLibrarySnapshot` call;
- exact/prefix/token/substring searches;
- first 100-row render-model batch.

The test should assert structural limits rather than fragile wall-clock timings: one resolver call per generation, zero filesystem calls, no Extension Host work on query changes, and result batch size at most 100. Record observed macOS timings in the verification note.

- [ ] **Step 5: Perform manual functional verification**

Verify all four sources in RU/EN/Both, category tree/counts, multiline preview, insert/copy/open, Add/Change nested category, live regroup after save, profile switch, catalog refresh, panel reopen state, narrow layout, keyboard-only use, light/dark/high-contrast themes, and no `Reload Window` requirement.

- [ ] **Step 6: Perform Windows/Parallels smoke verification**

On the established test VM, open a project on `C:\` and the `\\mac\Home` share. Confirm:

- panel opening introduces no extra workspace scan log;
- search/category changes stay immediate;
- IntelliSense and diagnostics remain immediate while the panel is open;
- canonical duplicate paths do not create duplicate project definitions;
- editing a nested category updates the panel without reloading the window;
- Extension Host CPU returns to idle after rendering.

- [ ] **Step 7: Update user documentation and changelog**

Document the three entry points, four sources, category metadata example, Add/Change CodeLens, insert/copy/open behavior, optional catalog-category availability, and fallback behavior. Add the feature under the unreleased/2.8.0 section without changing the version in this task.

- [ ] **Step 8: Perform final spec-coverage review**

Create a checklist from all 18 spec sections and map each acceptance criterion to a passing automated test or explicit manual result. Verify public interface names agree across source, tests, package contributions, and localization. Re-run the placeholder scan after documentation changes.

- [ ] **Step 9: Commit final verification/documentation fixes**

```bash
git add README.md CHANGELOG.md docs/superpowers/specs/2026-09-25-visual-step-library-design.md
git commit -m "docs: describe visual step library"
```

- [ ] **Step 10: Request code review before pushing**

Use `superpowers:requesting-code-review`, resolve all actionable findings, rerun `npm run check`, `npm run vscode:prepublish`, package the VSIX again, and verify every new commit uses the approved noreply address before updating the PR branch.
