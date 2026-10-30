# Scenario Descriptor and Runtime Identity Design

## Context

The duplicate-aware `ScenarioCatalog` preserves every `scen.yaml` definition and indexes it by URI, but `PhaseSwitcherProvider` still publishes a compatibility `Map<string, TestInfo>` and keeps selection, build artifacts, run state, log trackers, and webview state under the scenario name. Two definitions with the same name therefore become indistinguishable inside Test Manager even though the catalog itself is correct.

Scenario metadata is also assembled twice. `workspaceScanner.ts` and `PhaseSwitcherProvider.buildTestInfoFromDocument()` independently parse the same header, nested-scenario, parameter, KOT description, and PhaseSwitcher metadata. Their regular-expression implementations have already diverged and can produce different `TestInfo` values for the same source.

## Goal

Make the YAML file URI the stable identity of a scenario throughout Test Manager runtime state, and make one pure descriptor parser the only source of `TestInfo` metadata for both disk scans and open documents.

## Constraints

- Do not change AI code, `steps.htm`, `stepsFetcher.ts`, completion ranking, or IntelliSense behavior.
- Do not change the KOT YAML format, generated feature/JSON file names, command IDs, or visible scenario names.
- Keep the external 1C:Drive scenario corpus read-only and verify all 1,885 files.
- Preserve legacy stored checkbox selections where their old name identifies the deterministic compatibility definition.
- Never attach a name-only artifact or run log to an arbitrary definition when the name is duplicated.
- Keep the work on `codex/reliability-foundation` and retain the existing public catalog APIs while consumers migrate.

## Considered Approaches

### Extend the compatibility name map

A composite value under each name could carry every definition, but every runtime map and webview object would still collide on the string name. This only moves the ambiguity and is rejected.

### Use UID as the runtime key

UID is domain-friendly but optional in the accepted corpus, may be temporarily absent while editing, and is not the identity already used by file watchers and incremental catalog updates. This would require a fallback identity and additional migration rules, so it is rejected.

### Use canonical YAML URI keys and a shared descriptor parser

This is the selected approach. `yamlFileUri.toString()` is already the catalog's exact key, survives duplicate names, and matches watcher/update boundaries. UID and name remain searchable metadata. One pure parser produces a descriptor from text; the scanner and open-document path only add URI and relative-path context.

## Shared Scenario Descriptor

Create `src/scenarioDescriptor.ts` without VS Code imports. It exposes:

```ts
export interface ParsedScenarioDescriptor {
    readonly name?: string;
    readonly uid?: string;
    readonly scenarioCode?: string;
    readonly scenarioCodeLine?: number;
    readonly scenarioCodeLineStartCharacter?: number;
    readonly scenarioCodeLineEndCharacter?: number;
    readonly parameters?: readonly string[];
    readonly parameterDefaults?: Readonly<Record<string, string>>;
    readonly nestedScenarioNames?: readonly string[];
    readonly scenarioDescription?: string;
    readonly phaseSwitcher?: {
        readonly hasTab: boolean;
        readonly tabName?: string;
        readonly defaultState?: boolean;
        readonly order?: number;
    };
}

export function parseScenarioDescriptor(source: string): ParsedScenarioDescriptor;
```

The function creates one `ScenarioYamlDocument` and reads `ДанныеСценария` scalars and source ranges through it. `ВложенныеСценарии` and the scanner-facing parameter defaults come from `readRecords()`, so comments, quoted punctuation, and similarly named fields in other sections cannot be mistaken for scenario metadata. Existing specialized KOT description and PhaseSwitcher metadata parsers remain implementation helpers in this increment because they support legacy KOT payloads; callers no longer invoke them independently.

`parseScenarioParameterDefinitions()` remains available for editor commands that need precise value ranges. The descriptor parser owns the read-only catalog representation; it does not replace range-aware parameter editing.

The same module exports `buildTestInfoFromScenarioDescriptor(descriptor, yamlFileUri, relativePath)`. It imports `TestInfo` only as a TypeScript type and does not import the VS Code runtime. Both `readScenarioInfo()` and the open-document update path call this adapter. Missing names return `null`; all optional values are normalized identically.

## Runtime Identity

Add `src/scenarioRuntimeIdentity.ts` as a pure module:

```ts
export type ScenarioRuntimeKey = string;

export interface ScenarioRuntimeTarget {
    readonly key?: ScenarioRuntimeKey;
    readonly name?: string;
}

export function getScenarioRuntimeKey(info: TestInfo): ScenarioRuntimeKey;
export function resolveScenarioRuntimeTarget(
    catalog: ScenarioCatalog,
    target: ScenarioRuntimeTarget
): ScenarioResolution;
export function migrateLegacySelectionStates(
    catalog: ScenarioCatalog,
    legacyByName: Readonly<Record<string, boolean>>,
    currentByKey?: Readonly<Record<string, boolean>>
): Record<ScenarioRuntimeKey, boolean>;
```

`getScenarioRuntimeKey()` returns `yamlFileUri.toString()`. A supplied key resolves only through `catalog.byUri`; if a name is supplied too, it must match the resolved definition. A name-only target resolves only when unique. Ambiguity is returned, never collapsed through `primaryByName`.

Legacy checkbox state is migrated once. For a unique name, its value moves to that URI. For a duplicated name, the value moves only to the catalog's deterministic `primaryByName` definition because that is the only definition the old Test Manager exposed; other definitions receive their own `defaultState`. Existing URI-keyed values always take precedence.

## PhaseSwitcher State

The provider stops using `_testCache` as an internal source of truth. It iterates `catalog.all`, resolves exact definitions through `catalog.byUri`, and uses URI runtime keys for:

- checkbox selection state;
- build artifacts and stale markers;
- execution and last-launch state;
- live run-log and feature-step trackers;
- tracked external runs and active tracked-run selection;
- running and failed feature highlights.

Runtime records continue to contain `scenarioName` for messages and log interpretation, plus `sourceUri` or `scenarioKey` for identity. Helper methods resolve `TestInfo` from the catalog at the boundary instead of looking it up by name.

Name-only discovery remains necessary for generated artifacts and Vanessa logs. It follows this rule:

1. If a persisted session or command supplies a URI key, use that exact definition.
2. If the name has one catalog definition, use its URI key.
3. If the name is duplicated and no URI evidence exists, skip association and log one warning; do not choose `primaryByName`.

Build filters still contain scenario names because SPPR/Vanessa accepts names, not URIs. The selection snapshot is computed from URI-keyed checkbox entries and then projected to names. Selecting two definitions with the same runtime name is rejected before build with a clear ambiguity message because the downstream build interface cannot address them independently.

## Webview Protocol

Every `PhaseSwitcherWebviewTestInfo` includes required `scenarioKey` and `yamlFileUriString`. DOM rows and controls store both `data-key` and `data-name`. JavaScript objects `initialTestStates`, `currentCheckboxStates`, and `runArtifacts` are keyed by `scenarioKey`.

Messages for scenario-specific commands contain:

```js
{ command: 'runScenarioInVanessa', key: scenarioKey, name, uri }
```

The provider resolves `key` first and validates optional `name`/`uri`. Legacy command invocations containing only a name continue to work for unique names and present the existing disambiguation flow for duplicates. Rename, delete, favorites, and open-scenario commands retain their current URI behavior.

## Rename, Delete, and Invalidation

A content-only rename keeps the same URI key; displayed names and artifact metadata update without moving runtime state. A directory/file rename changes the URI key. The existing watcher rename transaction remaps runtime maps from old URI to new URI only after the new descriptor is parsed successfully. Delete removes state for the exact URI and cannot clear a same-named sibling.

Catalog invalidation clears runtime entries whose URI no longer exists. It does not re-key by name. Artifact restoration after extension restart associates only unique names; ambiguous recovered files remain unbound until rebuilt from an exact selected scenario.

## Testing

Pure Node tests cover:

- one descriptor parser reading quoted header values, nested records, parameters, description, metadata, BOM, and CRLF offsets;
- scanner and open-document adapters producing equal metadata from the same source;
- exact URI resolution and rejection of stale key/name pairs;
- legacy selection migration for unique and duplicate names;
- URI-keyed rename and deletion preserving same-named siblings;
- ambiguous name-only artifact/log resolution returning no runtime key;
- build-filter projection rejecting two selected URI keys with the same name.

The webview contract test executes the JavaScript contract helpers or checks observable generated row/message data; it must not merely assert source strings. Full verification includes `npm test`, `npm run check`, `npm run vscode:prepublish`, `git diff --check`, and the read-only 1C:Drive corpus verifier.

## Rollout

Implement in two independently green increments:

1. Introduce `ParsedScenarioDescriptor`, switch scanner and open-document construction to it, and verify the entire corpus without changing runtime identity.
2. Introduce URI runtime keys, migrate persisted selection state and webview messages, then convert artifacts and run tracking. Remove `_testCache` only after no internal call site depends on `primaryByName`.

No persistent catalog or artifact format is added. Workspace state migration is idempotent and can read the old name-keyed object until the new URI-keyed object has been saved successfully.

## Acceptance Criteria

- Disk scans and open-document updates produce the same `TestInfo` metadata through one descriptor parser.
- No scanner or PhaseSwitcher method independently extracts scenario header or nested-scenario metadata with regex.
- Test Manager displays every main-scenario definition, including duplicated names, with independent URI-keyed checkbox state.
- All scenario-specific webview actions carry and resolve an exact URI runtime key.
- Runtime maps, restored artifacts, and run-log association never silently choose a duplicated name.
- Legacy name-keyed checkbox state migrates without losing the previously visible deterministic selection.
- `_testCache` and `primaryByName` are no longer used inside `PhaseSwitcherProvider`.
- AI, `steps.htm`, `stepsFetcher.ts`, completion ranking, and IntelliSense behavior remain unchanged.
- All project checks and the full read-only corpus verification pass.
