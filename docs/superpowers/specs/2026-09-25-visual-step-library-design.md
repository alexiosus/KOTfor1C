# Visual Step Library Design

**Date:** 2026-09-25

**Status:** Approved

**Target branch:** `codex/reliability-foundation`

## 1. Context

KOT for 1C already resolves four kinds of callable definitions:

- built-in Vanessa Automation steps;
- user steps registered from BSL sources;
- exported Feature scenarios;
- nested YAML scenarios.

Those definitions are available through IntelliSense, hover, diagnostics, and navigation, but there is no dedicated place to browse the complete library. Users must know enough of a step name to invoke IntelliSense, and categories present in Vanessa and project metadata are not exposed as a navigable hierarchy.

The selected interface is the three-pane **Categories + list + details** layout:

1. sources and hierarchical categories on the left;
2. matching definitions in the center;
3. description, parameters, translations, source, and actions on the right.

The visual library must reuse the same definitions and insertion rules as IntelliSense. It must not become a second scanner, matcher, or source of truth.

## 2. Goals

1. Provide one searchable visual library for all definitions callable from a scenario.
2. Preserve the category hierarchy supplied by Vanessa and project authors.
3. Insert a selected definition using the same snippets and multiline formatting as IntelliSense.
4. Navigate from project definitions to their BSL, Feature, or YAML source.
5. Update without `Reload Window` when catalogs, profiles, or source files change.
6. Keep search and filtering responsive on Windows, including Parallels and network folders.
7. Remain compatible with old step catalogs and the bundled/custom HTML fallback.

## 3. Non-goals

- Removing `steps.htm` fallback support.
- Extracting definitions directly from an EPF at extension runtime.
- Editing the implementation of a user step inside the visual library.
- Providing fuzzy Levenshtein search in the panel.
- Replacing IntelliSense, hover, or existing definition navigation.
- Automatically deriving a nested-scenario category from `PhaseSwitcher.Tab`.

## 4. Callable sources

The library exposes four root source groups:

| Root | Definition kind | Category source | Navigation |
| --- | --- | --- | --- |
| Vanessa Automation | `builtInStep` | Published Vanessa `ТипШага` path | Not available in v1 |
| User steps | `userStep` | Sixth argument of `ДобавитьШагВМассивТестов` | BSL implementation/registration |
| Export scenarios | `exportScenario` | `@steptype` / `@типшага` metadata | Feature scenario |
| Nested scenarios | `nestedScenario` | `KOTМетаданные.Категория` | YAML scenario |

Definitions without a category remain visible under **Uncategorized / Без категории**.

## 5. Nested-scenario category metadata

### 5.1 Format

Nested YAML scenarios may declare an optional category at the top level of `KOTМетаданные`:

```yaml
KOTМетаданные:
    Категория: "Продажи.Заказы"
    Описание: |
        Проверяет создание и проведение заказа клиента.
    PhaseSwitcher:
        Tab: "Регресс"
```

`Категория` and `PhaseSwitcher.Tab` are independent:

- `Категория` organizes callable definitions in the visual library;
- `PhaseSwitcher.Tab` organizes executable tests in Test Manager.

No implicit fallback or migration between those fields is performed.

### 5.2 Parsing and propagation

The descriptor pipeline gains `scenarioCategory?: string`:

1. `ScenarioYamlDocument` reads `KOTМетаданные.Категория` as a scalar.
2. `parseScenarioDescriptor` trims it and rejects an empty result as absent.
3. `buildTestInfoFromScenarioDescriptor` copies it into `TestInfo`.
4. `nestedDefinition` copies it into `ProjectDefinition.category`.
5. Scenario catalog identity includes the category so a category-only edit invalidates the resolver view.

Existing files without the field remain valid.

### 5.3 Editing and creation

Scenario creation surfaces expose an optional category field. The chooser contains distinct existing nested-scenario categories from the active workspace and also accepts new text.

Existing scenarios receive a CodeLens on `KOTМетаданные` with **Add category** or **Change category**. It uses the same existing-category chooser and free-text input as scenario creation, matching the category workflow already used for export-scenario metadata.

The YAML mutation must use `ScenarioYamlDocument` ranges and preserve:

- BOM;
- CRLF/LF style;
- indentation;
- comments;
- existing key ordering and scalar style when updating an existing value.

If `KOTМетаданные` is structurally ambiguous or not a mapping, the mutation fails without modifying the document.

## 6. Vanessa category enrichment

### 6.1 Why the translation table is insufficient

Vanessa's translation `Template.xml` contains localized step text and category translations, but it does not provide a dependable step-to-category relationship. Category ownership must not be inferred from row order.

Vanessa BSL registrations already provide `ТипШага` as the sixth argument of `ДобавитьШагВМассивТестов`. The publication workflow has the full official source archive for the exact release, so category enrichment belongs in CI rather than extension activation.

### 6.2 Catalog model

`BuiltInStepDefinition` gains an optional category path:

```ts
interface StepCategoryPath {
    readonly ru?: readonly string[];
    readonly en?: readonly string[];
}

interface BuiltInStepDefinition {
    readonly id: string;
    readonly ru?: StepTextVariant;
    readonly en?: StepTextVariant;
    readonly categoryPath?: StepCategoryPath;
}
```

The JSON catalog keeps `schemaVersion: 1`. Older extensions already ignore unknown step fields, so enriched catalogs remain readable. The step ID continues to depend only on RU/EN patterns and therefore remains stable.

The parser validates `categoryPath` only when present. Catalogs without it, cached old catalogs, custom HTML, and bundled HTML continue to load.

### 6.3 Source extraction

During catalog publication:

1. Recursively enumerate `.bsl` files from the downloaded Vanessa source archive.
2. Skip a file before tokenization unless it contains `ДобавитьШагВМассивТестов` case-insensitively.
3. Parse static registrations with shared BSL tokenization and expression evaluation.
4. Collect normalized display template, description, and `ТипШага`.
5. Match registrations to `Template.xml` rows by normalized Russian display template.
6. Split `ТипШага` by `.` into a path after trimming empty segments.
7. Translate the path from the category translations extracted from `Template.xml`.
8. Attach the path to the matching built-in definition.

The reusable parser must remain pure and must not depend on VS Code APIs.

### 6.4 Conflicts and missing data

- Repeated registrations with the same normalized template and same category collapse to one mapping.
- Conflicting non-empty categories for the same normalized template are reported and left uncategorized rather than selected arbitrarily.
- Dynamic registration expressions that cannot be evaluated are reported and skipped.
- An unmatched catalog step remains in the catalog without a category.
- No failure in enrichment may remove an executable step.

The generation report gains:

- categorized step count;
- uncategorized step count;
- unmatched registration count;
- conflicting category mappings;
- untranslatable category segments.

Initial publication records coverage without enforcing a percentage threshold. A threshold may be introduced after observing a stable baseline across Vanessa releases.

## 7. Shared definition presentation

The visual library consumes `ProjectDefinitionResolver.getView(resource)` and filters to the four supported kinds. It never enumerates workspace files itself.

The resolver representation is extended only where necessary:

- built-in definitions receive their localized category path;
- nested definitions receive `KOTМетаданные.Категория`;
- existing user/export `category` values are preserved;
- paired built-in RU/EN definitions receive a stable family ID so the list can show one selected-language row and the details pane can show its translation;
- a stable presentation ID combines definition ID and language variant.

A pure `StepLibraryModel` converts definitions into a compact webview payload:

```ts
interface StepLibraryItem {
    readonly id: string;
    readonly definitionId: string;
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
}
```

Only serializable values cross the webview boundary. Maps, VS Code objects, regexes, and full source text remain in the extension host.

Snippet syntax is not sent to the webview. Insert messages contain only the presentation ID; the extension resolves the current definition again and constructs the snippet on the trusted side.

## 8. Panel UX

### 8.1 Entry points

The panel opens through:

- `KOT: Open Step Library` in the Command Palette;
- a Test Manager toolbar/menu action;
- an editor-title action for supported YAML and Feature documents.

There is one panel instance per extension host. Reopening reveals the current panel and refreshes it when necessary.

### 8.2 Layout

The selected layout has three panes:

1. **Sources and categories** — root source groups, nested category paths, and item counts.
2. **Definitions** — result list ordered by relevance or alphabetically within a selected category.
3. **Details** — description, parameters, translation/variant, source, category, and actions.

At narrow widths the details pane becomes an explicit details view instead of forcing horizontal scrolling. At the smallest width the category pane may collapse behind a toolbar action.

### 8.3 Filters

The toolbar includes:

- free-text search;
- RU / EN / Both for built-in variants;
- source/category selection;
- refresh action using the existing refresh services.

User, export, and nested definitions remain visible in the language mode in which they were authored. Language filtering must not hide them merely because they lack explicit language metadata.

### 8.4 Search

Search is performed inside the webview over a precomputed normalized search string containing:

- display template;
- alternate localized template when available;
- description;
- category segments;
- source label;
- parameter names.

Ranking is deterministic:

1. exact display-template match;
2. display-template prefix;
3. token-prefix match;
4. substring match in template;
5. substring match in metadata.

No edit-distance matrix or full-library synchronous work runs in the Extension Host while typing. Search input uses a short client-side debounce and yields between large render batches when necessary.

### 8.5 Selection and actions

- Single click selects a definition.
- Double click and `Enter` invoke **Insert**.
- `Ctrl/Cmd+C` or **Copy** copies plain display text without snippet syntax.
- **Open definition** is shown for user, export, and nested definitions with a source location.
- Built-in definitions show Vanessa version and source but no navigation action in the first version.

Keyboard navigation supports the category tree, result list, and actions without requiring a mouse.

## 9. Shared snippet insertion

Snippet construction currently lives in `completionProvider.ts`. It must be extracted into a pure shared module used by both IntelliSense and the visual library.

The shared module is responsible for:

- `%N Hint` Vanessa placeholders;
- project-definition parameter placeholders;
- nested-scenario parameter blocks and defaults;
- Gherkin keyword selection;
- multiline step/table preservation;
- snippet escaping;
- plain display/copy text.

The panel tracks the most recent eligible editor because focusing a webview removes the text editor from `window.activeTextEditor`.

Insertion is enabled only when the captured editor and selection still form a supported Gherkin insertion context:

- a `.feature` document; or
- a supported Gherkin-bearing location in a scenario YAML document.

The context check is shared with IntelliSense. If the document, version, or selection is stale, the extension revalidates the current editor before inserting. Invalid contexts disable insertion and produce no document edit.

`TextEditor.insertSnippet` performs the final edit, preserving native tab-stop behavior and multiple cursors.

## 10. Navigation

The panel reuses `openProjectDefinitionHandler`.

Each item includes both its definition ID and a captured serializable location. If the resolver view changes between rendering and clicking:

1. navigation first resolves the current definition ID;
2. if it no longer exists, it uses the captured location;
3. if neither is valid, the panel reports that the source is no longer available.

This matches hover navigation and avoids stale-definition failures after a refresh.

## 11. Webview lifecycle and updates

`StepLibraryPanel` subscribes to:

- `ProjectDefinitionResolver.onDidChangeView`;
- active editor and selection changes;
- relevant configuration/profile changes;
- panel visibility changes.

Refresh flow:

1. Increment a panel generation number.
2. Resolve the view asynchronously for the current workspace resource.
3. Build the pure presentation model.
4. Discard the result if a newer generation exists.
5. Post state only when the view identity or insertion-target state changed.

The webview retains local UI state with `vscode.getState` / `vscode.setState`:

- query;
- selected source/category;
- expanded category nodes;
- selected item;
- language filter;
- sort mode.

When data changes, unavailable selections fall back to the closest surviving category or the first result.

The panel updates automatically after user-step or export-scenario file changes, scenario catalog updates, profile changes, and built-in catalog refreshes. It does not require `Reload Window`.

## 12. Security and message validation

- Use a restrictive CSP and per-render nonce.
- Load only extension-local scripts, styles, and Codicons.
- Escape all text rendered in generated HTML.
- Render definition content with `textContent`, not `innerHTML`.
- Validate every incoming command and scalar payload.
- Resolve definitions and locations on the extension side; never accept an arbitrary URI to open from the webview.
- Do not execute Markdown or HTML contained in descriptions.

## 13. Performance budget

The target corpus is approximately two thousand definitions and may grow.

- Opening from an already prepared resolver view should display the first state within 200 ms on the reference macOS environment and remain interactive during background refresh.
- Search/filter interaction should update within one animation frame for the normal corpus and avoid tasks longer than 50 ms.
- The Extension Host performs no per-keystroke catalog traversal.
- Category and search normalization occurs once per view identity.
- Rendering uses a bounded visible result window or incremental batches rather than rebuilding thousands of rich DOM nodes.
- No additional workspace scan is introduced by opening the panel.

Windows/Parallels smoke testing must confirm that IntelliSense and diagnostics remain responsive while the panel is open and while its filters change.

## 14. Error states

The panel distinguishes:

- loading definitions;
- no definitions configured;
- no results for the current filters;
- catalog fallback without built-in category metadata;
- project-index warning with partial results;
- refresh failure while retaining the last successful snapshot;
- unavailable insertion target;
- stale or unavailable source location.

Recoverable failures keep the last successful definitions visible and expose a retry/refresh action.

## 15. Localization

All extension-side labels use `vscode.l10n.t`. Webview strings are supplied as a localized dictionary. The initial implementation provides matching English and Russian strings.

Category names are data:

- built-in paths use the active RU/EN filter when a translation exists;
- project categories are shown exactly as authored;
- `Uncategorized / Без категории` is localized UI text.

## 16. Testing

### 16.1 Pure unit tests

- Parse, update, and safely reject `KOTМетаданные.Категория` edits.
- Offer Add/Change category CodeLens actions and the existing-category chooser.
- Propagate nested-scenario categories through descriptor, `TestInfo`, resolver, and cache identity.
- Parse static Vanessa registrations and category paths.
- Resolve repeated, conflicting, dynamic, and unmatched Vanessa mappings.
- Round-trip enriched and legacy schema-v1 catalogs.
- Build category trees and stable counts for all four sources.
- Rank search results without fuzzy edit distance.
- Build identical snippet/display output for IntelliSense and panel insertion.
- Preserve multiline steps and nested-scenario parameter blocks.
- Validate panel messages and stale-generation handling.

### 16.2 Contract tests

- Command, menus, activation, localization keys, and packaged media are registered.
- The publication workflow includes category extraction and report validation.
- Existing old catalogs and bundled/custom HTML still load.

### 16.3 Integration and manual verification

- Open the panel from Command Palette, Test Manager, and editor title.
- Browse each source and category.
- Insert built-in, user, export, and nested definitions into YAML and Feature files.
- Copy plain text and open project definitions.
- Edit a category and observe live regrouping without window reload.
- Switch the active profile and observe user/export source replacement.
- Refresh the Vanessa catalog and preserve panel usability.
- Verify light/dark/high-contrast themes and keyboard navigation.
- Verify cold start and active use on Windows under Parallels.

## 17. Compatibility and rollout

- `categoryPath` is optional and additive in schema version 1.
- Step IDs remain unchanged.
- Old clients ignore enriched fields.
- New clients place old/fallback built-in steps under Uncategorized.
- Existing YAML scenarios require no migration.
- Existing IntelliSense, hover, diagnostics, and navigation continue to use `ProjectDefinitionResolver`.

The feature is enabled by default. If the initial enriched catalog has incomplete category coverage, the visual library remains useful through search and source grouping while the publication report identifies gaps.

## 18. Acceptance criteria

The feature is complete when:

1. The visual library exposes all four callable definition kinds.
2. Vanessa definitions are grouped by published `ТипШага` where static source data permits.
3. Nested scenarios honor optional `KOTМетаданные.Категория` independently of Test Manager tabs.
4. Search, filtering, insertion, copying, and project navigation work from the panel.
5. IntelliSense and panel insertion share one snippet implementation.
6. File, profile, scenario, and catalog changes update the open panel without `Reload Window`.
7. Legacy catalogs and HTML fallbacks remain usable.
8. Full checks, packaging, and Windows/Parallels smoke tests pass.
