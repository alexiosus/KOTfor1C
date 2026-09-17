# Scenario Descriptor and Runtime Identity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse every `scen.yaml` descriptor through one shared implementation and make YAML URI the identity of every Test Manager runtime record.

**Architecture:** A pure `scenarioDescriptor` module converts source text into normalized metadata used by disk scans and open documents. A second pure `scenarioRuntimeIdentity` module owns URI keys, exact target resolution, legacy selection migration, and name-to-key ambiguity rules; `PhaseSwitcherProvider` and its webview consume those contracts while keeping scenario names only for display and Vanessa/SPPR arguments.

**Tech Stack:** TypeScript 5.9, Node.js `node:test`, VS Code Extension API, YAML CST adapter, plain browser JavaScript, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-17-scenario-descriptor-runtime-identity-design.md`

## Global Constraints

- Do not modify AI code, `steps.htm`, `stepsFetcher.ts`, completion ranking, or IntelliSense behavior.
- Do not change KOT YAML, generated artifact names, public command IDs, or visible scenario names.
- Keep `/Users/alexeremeev/Development/1cDrive/tests/RegressionTests/Yaml/Drive` read-only and verify all 1,885 files.
- Name-only resolution must never select one duplicated definition silently.
- Each task starts with a failing behavioral test and ends with the full project check green.
- Execute inline in the existing worktree to honor the user's limit-economy preference.

---

### Task 1: Shared parser-backed scenario descriptor

**Files:**
- Create: `src/scenarioDescriptor.ts`
- Create: `test/scenarioDescriptor.test.ts`
- Modify: `src/scenarioYamlDocument.ts`

**Interfaces:**
- Produces `ParsedScenarioDescriptor` and `parseScenarioDescriptor(source)`.
- Produces `buildTestInfoFromScenarioDescriptor(descriptor, yamlFileUri, relativePath)` without a runtime `vscode` import.

- [x] **Step 1: Write failing descriptor tests**

Use a hand-written CRLF/BOM fixture with a misleading `Имя` in another section, duplicate nested names, quoted punctuation, parameters, KOT description, and PhaseSwitcher metadata:

```ts
const descriptor = parseScenarioDescriptor(source);
assert.deepEqual(descriptor, {
    name: 'Main: #1',
    uid: 'uid-main',
    scenarioCode: '000000001',
    scenarioCodeLine: 3,
    scenarioCodeLineStartCharacter: 4,
    scenarioCodeLineEndCharacter: 25,
    parameters: ['Customer'],
    parameterDefaults: { Customer: '"Default: #1"' },
    nestedScenarioNames: ['Nested one'],
    scenarioDescription: 'Description',
    phaseSwitcher: {
        hasTab: true,
        tabName: 'Smoke',
        defaultState: true,
        order: 10
    }
});
```

Also assert that `buildTestInfoFromScenarioDescriptor()` returns `null` without `ДанныеСценария.Имя` and copies arrays/maps rather than exposing parser-owned mutable state.

- [x] **Step 2: Run the focused test and verify RED**

Run: `npm run compile-tests && node --test out/test/scenarioDescriptor.test.js`

Expected: compilation fails because `src/scenarioDescriptor.ts` does not exist.

- [x] **Step 3: Implement the descriptor and adapter**

The implementation creates exactly one `ScenarioYamlDocument`:

```ts
export function parseScenarioDescriptor(source: string): ParsedScenarioDescriptor {
    const yaml = ScenarioYamlDocument.parse(source);
    const codeField = yaml.findField('ДанныеСценария', 'Код');
    const parameterDefinitions = readParameterDefaults(yaml.readRecords('ПараметрыСценария'));
    return {
        name: trimOptional(yaml.readScalar('ДанныеСценария', 'Имя')),
        uid: trimOptional(yaml.readScalar('ДанныеСценария', 'UID')),
        scenarioCode: trimOptional(codeField?.value),
        ...getLineCoordinates(source, codeField),
        parameters: optionalUnique([...parameterDefinitions.keys()]),
        parameterDefaults: optionalRecord(parameterDefinitions),
        nestedScenarioNames: readNestedNames(yaml.readRecords('ВложенныеСценарии')),
        scenarioDescription: optionalText(parseKotScenarioDescription(source)),
        phaseSwitcher: normalizePhaseSwitcher(parsePhaseSwitcherMetadata(source))
    };
}
```

Use `normalizeScenarioCallParameterValue` for defaults so completion/diagnostics retain current quoting semantics.

- [x] **Step 4: Verify GREEN and regressions**

Run: `npm run compile-tests && node --test out/test/scenarioDescriptor.test.js out/test/scenarioYamlDocument.test.js out/test/scenarioParameterUtils.test.js`

Expected: all focused tests pass.

- [x] **Step 5: Commit**

Commit: `feat: add shared scenario descriptor parser`

---

### Task 2: Make scanner and open-document updates use the descriptor

**Files:**
- Modify: `src/workspaceScanner.ts`
- Modify: `src/phaseSwitcher.ts`
- Modify: `test/scenarioYamlCorpusVerifier.test.ts`
- Modify: `src/scenarioYamlCorpusVerifier.ts`

**Interfaces:**
- Consumes `parseScenarioDescriptor()` and `buildTestInfoFromScenarioDescriptor()`.
- Preserves `readScenarioInfo()` and `scanWorkspaceForScenarioCatalog()` signatures.
- Removes `PhaseSwitcherProvider.extractScenarioHeaderFields()` and both private nested-scenario regex parsers.

- [x] **Step 1: Add a failing parity/corpus test**

Add a pure verifier assertion that the descriptor has the same required identity for every corpus file and explicitly rejects fields borrowed from unrelated sections:

```ts
const descriptor = parseScenarioDescriptor(source);
assert.equal(descriptor.name, 'Correct scenario');
assert.equal(descriptor.scenarioCode, '000000123');
assert.deepEqual(descriptor.nestedScenarioNames, ['Nested']);
```

The production-change mutation caught by this test is reintroducing a whole-file `^\s*Имя:` scan.

- [x] **Step 2: Verify RED against the duplicated readers**

Run: `npm run compile-tests && node --test out/test/scenarioYamlCorpusVerifier.test.js`

Expected: the new parity API or assertion is unavailable before refactoring.

- [x] **Step 3: Replace scanner parsing**

Inside `readScenarioDefinitions`, replace line-by-line metadata extraction with:

```ts
const descriptor = parseScenarioDescriptor(fileContent);
const testInfo = buildTestInfoFromScenarioDescriptor(
    descriptor,
    fileUri,
    computeRelativeScenarioPath(fileUri, scanDirUri)
);
if (testInfo) definitions.push(testInfo);
```

Delete the scanner's nested-scenario parser and manual header/parameter state machine. Preserve cancellation, bounded concurrency, relative-path behavior, and error isolation.

- [x] **Step 4: Replace open-document parsing**

Implement `buildTestInfoFromDocument()` as the same adapter call using `document.getText()`, `document.uri`, and `computeRelativePathForScenarioFile()`. Delete `extractScenarioHeaderFields()` and `parseNestedScenarioNamesFromText()` from `PhaseSwitcherProvider` and remove obsolete imports.

- [x] **Step 5: Verify the full external corpus read-only**

Run: `npm run verify:yaml-corpus -- /Users/alexeremeev/Development/1cDrive/tests/RegressionTests/Yaml/Drive`

Expected: the current complete corpus (1,888 files on 2026-09-17), zero structural errors, zero warnings. Compare `git -C /Users/alexeremeev/Development/1cDrive status --short` before and after; outputs must be identical.

- [x] **Step 6: Run the full project check and commit**

Run: `npm run check`

Commit: `refactor: unify scenario descriptor parsing`

---

### Task 3: Pure URI runtime identity and selection migration

**Files:**
- Create: `src/scenarioRuntimeIdentity.ts`
- Create: `test/scenarioRuntimeIdentity.test.ts`

**Interfaces:**
- Produces `ScenarioRuntimeKey`, `getScenarioRuntimeKey`, `resolveScenarioRuntimeTarget`, `migrateLegacySelectionStates`, and `resolveUniqueRuntimeKeyByName`.
- Produces `validateEnabledScenarioKeys`, `remapRuntimeKey`, and `removeRuntimeKey` for later provider migrations.
- Consumes `ScenarioCatalog`, `ScenarioResolution`, and `TestInfo` only as pure values/types.

- [x] **Step 1: Write failing identity tests**

Cover exact key resolution, stale key/name rejection, ambiguous name-only rejection, and legacy state migration:

```ts
assert.deepEqual(
    migrateLegacySelectionStates(catalog, { Duplicate: true }, {}),
    {
        'file:///a/scen.yaml': true,
        'file:///b/scen.yaml': false
    }
);
assert.equal(resolveUniqueRuntimeKeyByName(catalog, 'Duplicate'), null);
```

The second duplicate uses its `defaultState`; an existing URI-keyed value overrides the legacy value.

- [x] **Step 2: Run focused tests and verify RED**

Run: `npm run compile-tests && node --test out/test/scenarioRuntimeIdentity.test.js`

Expected: module-not-found failure.

- [x] **Step 3: Implement minimal pure identity helpers**

Key and target resolution must be strict:

```ts
export function getScenarioRuntimeKey(info: TestInfo): ScenarioRuntimeKey {
    return info.yamlFileUri.toString();
}

export function resolveUniqueRuntimeKeyByName(
    catalog: ScenarioCatalog,
    name: string
): ScenarioRuntimeKey | null {
    const resolution = resolveScenarioByName(catalog, name.trim());
    return resolution.kind === 'unique' ? getScenarioRuntimeKey(resolution.scenario) : null;
}
```

Migration iterates stable `catalog.all`; for each definition it applies current URI state, then legacy state only to `primaryByName.get(name)`, then `defaultState === true`.

Define the remaining pure contracts explicitly:

```ts
export type ScenarioBuildSelectionValidation =
    | { kind: 'valid' }
    | { kind: 'ambiguous'; name: string; keys: readonly ScenarioRuntimeKey[] };

export function validateEnabledScenarioKeys(
    catalog: ScenarioCatalog,
    enabledKeys: readonly ScenarioRuntimeKey[]
): ScenarioBuildSelectionValidation;

export function remapRuntimeKey<T>(
    records: ReadonlyMap<ScenarioRuntimeKey, T>,
    oldKey: ScenarioRuntimeKey,
    newKey: ScenarioRuntimeKey
): Map<ScenarioRuntimeKey, T>;

export function removeRuntimeKey<T>(
    records: ReadonlyMap<ScenarioRuntimeKey, T>,
    key: ScenarioRuntimeKey
): Map<ScenarioRuntimeKey, T>;
```

`validateEnabledScenarioKeys` returns the first stable duplicate-name group among enabled definitions. The map helpers return copies and never remove a same-named sibling.

- [x] **Step 4: Verify GREEN and commit**

Run: `npm run compile-tests && node --test out/test/scenarioRuntimeIdentity.test.js out/test/scenarioIdentity.test.js out/test/scenarioCatalog.test.js`

Commit: `feat: add URI-backed scenario runtime identity`

---

### Task 4: URI-keyed Test Manager selection and webview protocol

**Files:**
- Create: `media/phaseSwitcherProtocol.js`
- Modify: `media/phaseSwitcher.js`
- Modify: `src/phaseSwitcher.ts`
- Modify: `test/phaseSwitcherWebviewContract.test.ts`
- Modify: `test/scenarioRuntimeIdentity.test.ts`

**Interfaces:**
- Adds required `scenarioKey` to `PhaseSwitcherWebviewTestInfo`.
- Persists selection states as `{ version: 2, byKey: Record<ScenarioRuntimeKey, boolean> }` while reading the legacy name-keyed object.
- Produces executable browser/Node protocol helpers `getScenarioKey(testInfo)` and `createScenarioCommand(command, testInfo, extra)`.

- [ ] **Step 1: Replace source-text contract tests with failing behavior tests**

Load `media/phaseSwitcherProtocol.js` in Node and assert observable payloads:

```ts
assert.deepEqual(protocol.createScenarioCommand('runScenarioInVanessa', {
    scenarioKey: 'file:///a/scen.yaml',
    name: 'Duplicate',
    yamlFileUriString: 'file:///a/scen.yaml'
}), {
    command: 'runScenarioInVanessa',
    key: 'file:///a/scen.yaml',
    name: 'Duplicate',
    uri: 'file:///a/scen.yaml'
});
```

Also assert it throws or returns `null` when `scenarioKey` is missing.

- [ ] **Step 2: Verify RED**

Run: `npm run compile-tests && node --test out/test/phaseSwitcherWebviewContract.test.js`

Expected: protocol module does not exist.

- [ ] **Step 3: Implement and load the protocol helper**

Use a small UMD-style module so Node tests and the webview execute the same code:

```js
(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    root.PhaseSwitcherProtocol = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    function createScenarioCommand(command, testInfo, extra = {}) {
        const key = String(testInfo?.scenarioKey || '').trim();
        if (!key) throw new Error('Scenario runtime key is required');
        return { command, key, name: testInfo.name, uri: testInfo.yamlFileUriString, ...extra };
    }
    return { createScenarioCommand };
});
```

Add its webview URI before `phaseSwitcher.js` in the generated HTML.

- [ ] **Step 4: Key selection state and rendered rows by URI**

Build Test Manager rows from `catalog.all`, not `_testCache.values()`. Set `scenarioKey` from `getScenarioRuntimeKey(info)`. Change checkbox/state objects, phase counts, `data-key`, artifact lookup, and command payload creation in `media/phaseSwitcher.js` to use the key while retaining `data-name` for filtering and display.

- [ ] **Step 5: Migrate provider persistence**

Read both shapes from `workspaceState`. After the catalog is available, call `migrateLegacySelectionStates`, save only version 2, and delete/update exact URI keys on file rename/delete. `getMainScenarioSelectionSnapshotForBuild()` returns enabled/disabled definitions and projects their names only at the SPPR filter boundary.

- [ ] **Step 6: Verify focused and full tests, then commit**

Run: `npm run check`

Commit: `refactor: key Test Manager selection by scenario URI`

---

### Task 5: URI-key build artifacts and exact command resolution

**Files:**
- Modify: `src/phaseSwitcher.ts`
- Modify: `media/phaseSwitcher.js`
- Modify: `test/scenarioRuntimeIdentity.test.ts`

**Interfaces:**
- `_scenarioBuildArtifacts` and `_staleBuiltScenarioNames` use `ScenarioRuntimeKey`.
- `ScenarioBuildArtifact` carries `scenarioKey`, `scenarioName`, and `sourceUri`.
- Scenario-specific messages resolve `{ key, name, uri }` through `resolveScenarioRuntimeTarget` before any operation.

- [ ] **Step 1: Add failing projection/ambiguity tests**

Test a pure helper that associates name-only recovered artifacts only for unique names:

```ts
assert.equal(resolveUniqueRuntimeKeyByName(catalog, 'Unique'), 'file:///u/scen.yaml');
assert.equal(resolveUniqueRuntimeKeyByName(catalog, 'Duplicate'), null);
```

Test the build-selection validator: two enabled keys with the same name produce `{ kind: 'ambiguous', name, keys }`; one enabled sibling with the other physically excluded is accepted.

- [ ] **Step 2: Verify RED for the build-selection contract**

Run the focused runtime identity test and confirm the new validator is missing.

- [ ] **Step 3: Convert artifact indexing and restoration**

Use runtime key when artifacts originate from a selected `TestInfo`. During filesystem restoration, resolve basename/name only through `resolveUniqueRuntimeKeyByName`; log and skip duplicates. Pruning checks `catalog.byUri.has(key)` and deletion removes only that key.

- [ ] **Step 4: Convert scenario-specific webview handlers**

For run/open-feature/open-JSON/open-log/watch/manual commands, resolve the exact target first:

```ts
const resolution = resolveScenarioRuntimeTarget(catalog, {
    key: typeof message.key === 'string' ? message.key : undefined,
    name: typeof message.name === 'string' ? message.name : undefined
});
if (resolution.kind !== 'unique') {
    await this.reportScenarioResolutionFailure(resolution);
    return;
}
await this.runScenarioInVanessa(getScenarioRuntimeKey(resolution.scenario));
```

Legacy command-palette calls by name continue through the same resolver and existing duplicate picker.

- [ ] **Step 5: Verify and commit**

Run: `npm run check`

Commit: `refactor: bind build artifacts to scenario URI`

---

### Task 6: URI-key run tracking and compatibility-map removal

**Files:**
- Modify: `src/phaseSwitcher.ts`
- Modify: `src/hoverProvider.ts`
- Modify: `test/scenarioRuntimeIdentity.test.ts`
- Modify: `test/extensionActivationContract.test.ts`

**Interfaces:**
- All run-state, watcher, tracked-run, launch-context, and highlight maps use `ScenarioRuntimeKey`.
- Runtime records keep `scenarioName` solely for log matching and UI text.
- Removes `_testCache`, `getTestCache()`, and PhaseSwitcher access to `catalog.primaryByName`.

- [ ] **Step 1: Add failing same-name isolation tests**

Create two scenario keys sharing one name and exercise pure state remapping/removal helpers. Deleting or renaming key A must leave key B untouched. A name-only auto-detected log must return no key for the pair.

- [ ] **Step 2: Verify RED**

Run focused identity tests; expected failure is missing remap/removal helper behavior.

- [ ] **Step 3: Convert runtime maps methodically**

Change method parameters and map access in this order: execution state and launch contexts; live log watcher; feature-step tracker; external tracked runs; running/failed highlights. Each method receives `scenarioKey`, obtains display/log name through the artifact or `catalog.byUri`, and never calls `catalog.primaryByName`.

- [ ] **Step 4: Remove the compatibility cache**

Publish catalog events directly. Update hover provider's compatibility interface to consume `getScenarioCatalog()` and exact definitions. Remove `scanWorkspaceForTests` only if `rg` confirms no callers; otherwise keep it as an exported legacy adapter outside PhaseSwitcher.

- [ ] **Step 5: Prove the migration boundary is gone**

Run exact searches and inspect every remaining match:

```text
rg -n "_testCache|getTestCache\(|primaryByName" src/phaseSwitcher.ts src/hoverProvider.ts src/extension.ts
```

Expected: no PhaseSwitcher/hover runtime use. `primaryByName` may remain only in the catalog and exported scanner compatibility adapter.

- [ ] **Step 6: Verify and commit**

Run: `npm run check`

Commit: `refactor: isolate scenario runtime state by URI`

---

### Task 7: Full verification and recorded evidence

**Files:**
- Modify: `docs/superpowers/plans/2026-09-17-scenario-descriptor-runtime-identity.md`

**Interfaces:**
- Records reproducible evidence for both implementation increments.

- [ ] **Step 1: Verify excluded areas are untouched**

Compare from commit `d2c3c08` and confirm no changed path matches AI modules, `res/steps.htm`, `src/stepsFetcher.ts`, or `src/completionProvider.ts`.

- [ ] **Step 2: Verify the external corpus without writes**

Capture external repository status, run the corpus verifier, and compare status again. Expected: 1,885 files, zero structural errors/warnings, identical status output.

- [ ] **Step 3: Run all quality gates**

Run:

```text
git diff --check d2c3c08..HEAD
npm run check
npm run vscode:prepublish
```

Expected: TypeScript clean, ESLint warning-free, every Node test passes, and production bundle succeeds.

- [ ] **Step 4: Record identity evidence**

Record counts for catalog definitions/names/duplicate buckets, remaining compatibility search matches, `phaseSwitcher.ts` line delta, tests, corpus, and production build in this plan.

- [ ] **Step 5: Commit**

Commit: `test: verify URI-backed scenario runtime`
