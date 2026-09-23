# Project Step Libraries and Export Scenarios

## Status

Design approved in conversation on 2026-09-23 and awaiting final review of this written specification.

## Context

KOT currently understands two reusable Gherkin sources:

- built-in Vanessa Automation steps, supplied by the versioned step catalog;
- KOT nested scenarios, supplied by the YAML scenario catalog.

Projects can also contain export scenarios in `.feature` files and user-defined steps implemented in source dumps of 1C external data processors. Those definitions are not currently available consistently to completion, hover, diagnostics, definition navigation, or reference search. The same missing model would also force a future visual step library to implement another independent scanner.

The first version deliberately does not read or unpack binary `.epf` files. Existing definitions are indexed only when source `.bsl` is present. A later version may add opt-in background `.epf` extraction with progress, cancellation, and a persistent cache.

## Goals

1. Make export scenarios and source-backed user steps first-class project definitions.
2. Expose built-in steps, user steps, export scenarios, and nested scenarios through one consumer-facing resolver.
3. Use project definitions in completion, hover, diagnostics, definition navigation, opening, and reference search.
4. Allow creation from the command palette, unknown-step Quick Fixes, and the Test Manager creation menu.
5. Create export scenarios either in an existing export feature or in a new feature.
6. Create user steps in a source-first representation and build the resulting library into `.epf` only on an explicit command.
7. Preserve the current fast activation path and avoid synchronous work in the Extension Host.
8. Provide the data model that a later visual step library can consume without another scanning implementation.

## Non-goals

- Reading, unpacking, or indexing definitions from binary `.epf` files.
- Automatically rebuilding `.epf` after every source save.
- Renaming step templates or scenario calls across the workspace.
- Implementing the visual step library itself.
- Replacing the extension with a separate language server.
- Indexing inactive KOT profiles.
- Navigating to the source code of versioned built-in Vanessa steps.

## Terminology

- **Built-in step**: a definition from the versioned Vanessa catalog.
- **User step**: a step registered by source `.bsl` code through `ДобавитьШагВМассивТестов`.
- **Export scenario**: a Gherkin scenario or scenario outline made callable by `@ExportScenarios`.
- **Nested scenario**: an existing KOT scenario described by `scen.yaml`.
- **Project definition**: any of the four definition kinds exposed through the unified resolver.
- **Library root**: a directory resolved from the active KOT profile and searched for `.feature` and supported source files.

## Active-profile library resolution

Only the active KOT parameter profile participates in indexing.

The resolver obtains library roots in this order:

1. Effective Vanessa parameters under the aliases `КаталогиБиблиотек` or `librarycatalogs`.
2. If the effective Vanessa parameters contain no library roots, the build parameter `Libraries`.
3. If `Libraries` is empty, the build parameter `VanessaLibraries`.

An effective Vanessa value may be an array or a single string. A single string may contain one path or multiple paths separated by the platform path delimiter. Empty entries are discarded and duplicate normalized paths are removed without changing their first-seen order.

Absolute paths remain absolute. Relative paths resolve against the owning workspace folder. The project tokens `#SourcesPath` and `#Libraries` resolve against the workspace folder, matching the current KOT project layout. A value that still contains an unresolved `#Token` is excluded and reported once in the KOT output channel instead of being guessed.

Multi-root workspaces resolve one active profile and one definition view per workspace folder. A document uses the view of its containing workspace folder. Switching or editing the active profile invalidates the old view and schedules a new background load.

If the active profile has no resolvable library roots, built-in and nested definitions continue to work. Project-definition creation commands explain that a library root must first be configured in the active profile.

## Architecture

### ProjectDefinitionIndexService

`ProjectDefinitionIndexService` owns immutable snapshots of locally sourced definitions for a workspace folder and active profile. It coordinates:

- `ExportScenarioIndexer` for `.feature` definitions;
- `UserStepSourceIndexer` for supported `.bsl` definitions;
- file cache and watcher state;
- cancellation and atomic snapshot publication.

The service does not rescan KOT YAML scenarios and does not download built-in catalogs.

### ProjectDefinitionResolver

`ProjectDefinitionResolver` is the single consumer-facing API. For a document it composes:

- the current local snapshot from `ProjectDefinitionIndexService`;
- the existing `ScenarioCatalog` snapshot through a narrow adapter;
- the current resource-specific built-in catalog from `StepCatalogProvider`.

This composition preserves the existing ability to resolve different Vanessa versions for different workspace resources. Consumers receive one definition view even though the underlying sources retain independent lifecycle and cache rules.

`PhaseSwitcherProvider` will not absorb the new scanners. It continues to publish `ScenarioCatalog`; the resolver depends only on a small catalog-provider interface. This prevents additional responsibilities from accumulating in `phaseSwitcher.ts`.

### Definition model

Every definition exposes:

- stable identifier;
- kind: `builtInStep`, `userStep`, `exportScenario`, or `nestedScenario`;
- original display template or scenario name;
- normalized matching representation;
- language when known;
- ordered parameters and placeholder metadata;
- description and category when available;
- owning workspace folder, active profile, and library root;
- definition location when a local source exists;
- implementation location when distinct from the registration;
- source label used by completion, hover, and ambiguity pickers.

Built-in step identifiers reuse their catalog IDs. Nested scenario identifiers reuse their exact scenario URI identity. Local definition identifiers combine the definition kind, normalized source URI, source range, and normalized signature. File moves therefore produce a new identity while edits elsewhere in the same file do not.

Indexes are maintained by normalized signature/name, source URI, and stable ID. Matching retains the original source spelling for display and insertion.

## Export scenario parsing

The export parser is a line-oriented Gherkin parser limited to definition discovery. It supports:

- UTF-8 with or without BOM and CRLF or LF;
- `# language:` declarations;
- Russian and English feature, scenario, scenario outline, and structure keywords;
- feature-level and scenario-level tags;
- comments, descriptions, examples, data tables, and doc strings without confusing them with definitions.

A scenario or outline is exported when `@ExportScenarios` is attached to the feature or to that scenario. Background sections are never indexed as callable definitions.

The callable template is the scenario title without a leading Gherkin step keyword. Quoted segments and outline placeholders are represented as ordered parameters. The parser records the title range for definition navigation and uses description lines between the scenario title and its first step as documentation.

Calls are matched through a compiled template matcher shared by hover, definition navigation, references, and diagnostics. Matching is case-aware according to existing Gherkin behavior and does not use a workspace-wide raw regular-expression scan.

## User-step source parsing

The source indexer considers `.bsl` files beneath active library roots only when they contain a `ПолучитьСписокТестов` function or a call whose method name is `ДобавитьШагВМассивТестов`.

A small BSL lexical scanner recognizes:

- comments and string literals with doubled-quote escaping;
- balanced parentheses;
- multiline calls;
- local static string assignments;
- concatenation of static string values.

It extracts the standard registration arguments:

1. destination array;
2. snippet;
3. procedure/function name;
4. displayed step template;
5. description;
6. category/type when present.

The displayed template is used for completion and invocation matching. The snippet supplies additional parameter metadata. The registration call is the definition location; a statically named matching procedure or function is the preferred implementation location.

Dynamic expressions that cannot be evaluated statically are not guessed. The individual registration is skipped and a file-scoped index warning reports why it was unsupported. Other registrations in the file remain available.

## Snapshot lifecycle and performance

Activation does not wait for project-library indexing. Existing built-in and nested definitions remain available while the local snapshot loads in the background.

The local cache is stored in extension storage, not in the project repository. Its identity contains:

- schema version;
- workspace folder identity;
- active profile identity and normalized roots;
- source URI, size, and modification time;
- parser version.

Unchanged files reuse cached parsed definitions. Watchers rooted at each resolved library directory invalidate only the changed `.feature` or `.bsl` entry. A profile switch cancels pending work, disposes old watchers, and publishes the new snapshot only after it is internally consistent.

File enumeration and reading use bounded concurrency. Parsing yields periodically when processing a large source set, and every stage observes cancellation. Snapshot publication is atomic, so consumers never see a mixture of profiles or a partially rebuilt file set.

Reference usage scanning remains lazy. The first reference request scans KOT YAML sources under the configured scenario root, `.feature` files under the active library roots, and `.feature` files under the active profile's resolved `FeatureFolder`. It uses cancellation and bounded concurrency, then caches per-file results. Open unsaved documents override their disk cache entries. This avoids adding a second full usage scan to extension startup.

## Editor integration

### Completion

`DriveCompletionProvider` consumes the unified definition view. It keeps the existing language-aware fuzzy matching and snippet insertion behavior while adding user steps and export scenarios.

Completion details identify the definition kind and source library. Project definitions rank ahead of built-in definitions at otherwise equal relevance. Identical display templates from different sources remain separate items with source labels; the extension does not silently discard ambiguity.

### Hover

Hover uses the same matcher as completion and diagnostics. Local definitions show kind, template, description, parameters, category, relative source path, and an open-definition command. Multiple matches produce an ambiguity view listing every source instead of selecting one arbitrarily.

### Definition navigation

A standard VS Code `DefinitionProvider` is registered for supported YAML and `.feature` documents.

- Export scenarios open at their scenario title.
- User steps open at the implementation function or fall back to the registration call.
- Nested scenarios open their existing `scen.yaml` definition.
- Built-in steps without a local source return no file location; their hover documentation remains available.

The existing hover links and open commands delegate to the same resolver and picker used by the definition provider.

### References

A standard `ReferenceProvider` and the existing KOT reference-search command share one reference engine. It searches calls in scenario YAML and `.feature` files, excludes declaration ranges unless VS Code requests declarations, and returns exact ranges for the callable text.

Reference matching is template-aware. Argument values in quoted export-scenario calls and user steps therefore resolve to the parameterized definition instead of requiring literal title equality.

### Diagnostics

Step validation resolves against built-in steps, user steps, export scenarios, and nested scenarios through the same view. Known project definitions are no longer reported as unknown. Expensive similarity suggestions continue to run only in the deferred/cancellable suggestion path established by the existing performance work.

Ambiguous matches produce a dedicated diagnostic with the conflicting source locations. They are not treated as a successful unique resolution.

## Creation workflows

All entry points call shared creation services. The command palette, Quick Fixes, and Test Manager menu contain no separate file-generation logic.

### Test Manager creation menu

The existing creation menu gains:

- `Export scenario`;
- `User step`.

These appear alongside the existing main- and nested-scenario actions and dispatch the same commands registered for the palette.

### Export scenario creation

The command asks the user to select a resolved library root and then offers:

- add to an existing `.feature` containing export scenarios;
- create a new export `.feature`.

When invoked as a Quick Fix, the unknown invocation supplies the initial title and language. The leading step keyword is removed. Quoted argument values are detected and the user is asked to confirm parameter names rather than embedding example values as parameter names.

Adding to an existing file inserts a structurally valid scenario at the end of the feature while preserving BOM, line endings, indentation, and final newline. If the feature lacks `@ExportScenarios`, the command adds the tag after confirmation. Creating a new file writes the language declaration, export tag, feature header, and scenario header, then places the editor cursor on an indented empty body line for the user to enter the implementation.

### User-step creation

The command asks for:

- target library root;
- new or existing source library;
- displayed step template;
- parameter names;
- implementation procedure/function name;
- description and category.

New source libraries use this layout:

```text
<library>/
  step_definitions/
    <LibraryName>.epf
  step_definitions-src/
    <LibraryName>/
      Обработка.xml
      Обработка/...
```

The Vanessa installation is resolved first from the active profile's `VanessaFolder`, `VanessaDir`, or `VanessaPath`, and then from `kotTestToolkit.runVanessa.vanessaEpfPath` when the profile has no usable path. The metadata layout is based on that installation's `lib/TemplateEpfUF` so that the user's Vanessa version remains authoritative. KOT supplies a tested module skeleton implementing the stable `ПолучитьСписокТестов` registration contract.

For an existing source library, edits use exact ranges returned by the BSL parser. The registration is inserted in `ПолучитьСписокТестов`, and the implementation is appended at a structurally safe module boundary. If either insertion point is missing or ambiguous, the command refuses to modify the file and explains the required structure.

After creation, the implementation function opens in VS Code. Source creation succeeds even when no 1C platform is configured.

### Explicit `.epf` build

`Build user step library` is an explicit command. It selects the configured 1C platform and uses the existing startup-infobase/platform infrastructure to invoke Designer with argument arrays, never a shell-composed command.

The build loads the hierarchical source into a temporary `.epf` in the target directory. Only a successful Designer exit with an existing non-empty output allows atomic replacement of the final `.epf`. A failed build preserves both the source and the previous binary and exposes the Designer log in the KOT output channel.

This build capability does not parse `.epf` and does not add binary-only definitions to the index.

## Conflict behavior

The resolver never applies an undocumented source precedence to navigation or validation.

- Completion keeps conflicting definitions and labels their origins.
- Hover and definition navigation list all matching sources.
- Diagnostics report ambiguity when more than one callable template matches uniquely at the same specificity.
- Reference search can start from a selected stable definition ID, preventing same-named definitions from being mixed accidentally.

Project definitions receive a ranking boost only for completion ordering. Ranking does not change semantic resolution.

## Error handling and safety

- An unreadable or malformed source file cannot invalidate definitions from other files.
- Repeated identical index warnings are deduplicated per snapshot.
- Missing library roots and unresolved profile tokens are reported without blocking activation.
- All scans and reference searches support cancellation.
- Source edits use `WorkspaceEdit` against the version that was parsed; concurrent document changes cause a retry or refusal, not blind overwrite.
- Creation outside the workspace occurs only after the user explicitly selects that active-profile library root.
- No existing `.feature`, `.bsl`, or `.epf` is overwritten without structural validation and an atomic write path.
- Process arguments are passed separately and sensitive launch values are redacted from logs through existing helpers.

## Testing strategy

### Pure parser tests

- Russian and English export features.
- Feature-level and scenario-level `@ExportScenarios`.
- Scenarios, outlines, structures, quoted parameters, examples, tables, doc strings, comments, BOM, and CRLF.
- Multiline BSL registrations, doubled quotes, static variables, static concatenation, multiple registrations, and unsupported dynamic expressions.
- Correct registration and implementation source ranges.

### Index and lifecycle tests

- Active-profile alias and fallback resolution.
- Workspace-relative and tokenized paths.
- Duplicate-root normalization.
- Cache reuse and one-file invalidation.
- Cancellation and stale profile-result suppression.
- Atomic snapshot replacement and watcher disposal.
- Duplicate definitions retained with stable identities.

### Language-feature tests

- Completion and hover across all four definition kinds.
- Definition navigation to export title, user implementation, user registration fallback, and nested YAML.
- References from YAML and `.feature` with parameterized calls.
- Ambiguous definition presentation.
- Diagnostics recognize project definitions and preserve cancellable suggestions.

### Creation tests

- Adding to an existing export feature and creating a new one.
- Preserving BOM, line endings, indentation, and final newline.
- Adding registrations/functions to a structurally valid BSL module.
- Refusing ambiguous or unsafe source edits.
- Test Manager, palette, and Quick Fix entry points delegate to the same commands.
- Designer arguments, temporary output validation, atomic replacement, and failure preservation.

Integration fixtures are self-contained inside this repository. The external 1cDrive test project and Vanessa checkout are read-only reference corpora and are never modified by automated tests.

## Acceptance criteria

1. An export scenario under an active-profile library root appears in completion and hover without reloading VS Code.
2. F12 from its call opens the exact scenario declaration, and Shift+F12 finds calls in YAML and feature files.
3. A statically registered `.bsl` user step receives the same completion, hover, definition, reference, and diagnostic treatment.
4. Duplicate templates expose all definitions and produce an ambiguity diagnostic instead of silently selecting one.
5. Changing the active profile replaces project definitions without mixing old and new results.
6. The Test Manager creation menu, palette, and unknown-step Quick Fix can create export scenarios and source-first user steps.
7. Explicit source build cannot destroy a previously valid `.epf` when Designer fails.
8. Binary-only `.epf` definitions are neither unpacked nor presented as indexed in this version.
9. Extension activation and the first built-in completion do not wait for project-library indexing.
