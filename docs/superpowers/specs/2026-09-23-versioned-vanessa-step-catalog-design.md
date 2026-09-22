# Versioned Vanessa Step Catalog Design

## Context

The extension currently treats `res/steps.htm` as the built-in Vanessa Automation step library. `DriveCompletionProvider` and `DriveHoverProvider` independently fetch and parse the same four-column HTML table. Activation also calls both providers' forced refresh paths, so the file can be downloaded and parsed twice before the user requests completion or hover.

The HTML represents one Vanessa Automation version and cannot follow the version used by an individual project. Updating the extension whenever Vanessa changes would keep those release cycles coupled, while parsing or unpacking every project EPF during activation would require a 1C platform installation and would recreate an expensive catalog on user machines.

Vanessa's official repository contains the standard library sources and localization templates for every release tag. This makes a versioned catalog generated outside the Extension Host the most predictable primary source.

## Goal

Generate immutable, versioned catalogs of Vanessa Automation built-in steps in GitHub Actions and let the extension select and cache the exact catalog for the Vanessa version configured in each workspace folder.

The extension must keep IntelliSense, hover, and unknown-step diagnostics responsive before the network request finishes and when the network or exact catalog is unavailable.

## Non-goals

- Do not parse user libraries or exported scenarios in this increment.
- Do not launch 1C, unpack EPFs, or parse Vanessa BSL sources in the Extension Host.
- Do not use Vanessa's MCP/AI flow.
- Do not remove `res/steps.htm`; it remains the compatibility and first-run offline fallback.
- Do not automatically substitute a newer or older catalog when the exact Vanessa version is unavailable.
- Do not change step matching, semantic ranking, snippets, or the Gherkin language model except for their shared input representation.

## Considered Approaches

### Continue updating `steps.htm` with extension releases

This is simple and completely offline, but it preserves the version lock and makes projects using older Vanessa releases receive incorrect hints after an extension update. It is retained only as fallback.

### Parse or unpack the project Vanessa distribution at runtime

Parsing source is not possible for the usual binary release without unpacking every EPF. Designer-based unpacking requires a locally installed, compatible 1C platform and is too expensive for activation. A background explicit command could be added later for unusual local builds, but it is not the primary path.

### Generate immutable catalogs in CI and resolve them by project version

This is the selected approach. Generation cost and source-format complexity stay in CI, published versions are retained, and adding a Vanessa release does not require publishing a new VS Code extension.

## Catalog Model

Introduce a VS Code-independent model in `src/stepCatalog.ts`:

```ts
export interface StepTextVariant {
    readonly pattern: string;
    readonly description: string;
}

export interface BuiltInStepDefinition {
    readonly id: string;
    readonly library: string;
    readonly procedure?: string;
    readonly kind?: string;
    readonly ru?: StepTextVariant;
    readonly en?: StepTextVariant;
}

export interface BuiltInStepCatalog {
    readonly schemaVersion: 1;
    readonly vanessaVersion: string;
    readonly generatedAt: string;
    readonly source: {
        readonly repository: "Pr-Mex/vanessa-automation";
        readonly ref: string;
        readonly commit: string;
    };
    readonly steps: readonly BuiltInStepDefinition[];
}
```

At least one language variant is required. Empty patterns are rejected. Newlines and whitespace are normalized by the generator, not by consumers. `id` is deterministic from the source library, procedure, and canonical Russian or English pattern; array order is deterministic as well. Timestamps are metadata and are excluded from the deterministic-content comparison used by CI.

The publication index has its own schema:

```ts
export interface StepCatalogIndex {
    readonly schemaVersion: 1;
    readonly generatedAt: string;
    readonly catalogs: Readonly<Record<string, {
        readonly path: string;
        readonly sha256: string;
        readonly stepCount: number;
        readonly sourceCommit: string;
    }>>;
}
```

The index path is relative to the index URL. The extension accepts only HTTPS URLs by default, limits response size, validates the complete JSON shape, verifies SHA-256, and confirms that the requested version equals `catalog.vanessaVersion` before replacing a cached catalog.

## CI Generator

Add a Node generator under `tools/step-catalog/` with no VS Code dependency. It receives an already checked-out Vanessa source directory, release version, source ref, and output path. Unit tests use small checked-in fixtures; they never download Vanessa.

The generator scans only the standard library sources represented by `features/Libraries` and the corresponding official step-localization templates. It uses a purpose-built BSL lexical reader rather than regular expressions over whole files. The reader understands comments, quoted strings with doubled quotes, multiline strings, balanced parentheses, omitted arguments, and top-level concatenation of static strings. It extracts registrations made through `ДобавитьШагВМассивТестов`, then pairs Russian and English variants by stable source identity and localization data.

Dynamic expressions that cannot be evaluated statically are reported with file and line. They are not silently discarded: generation fails unless the expression is in a reviewed allowlist with an explanation. Duplicate IDs, duplicate patterns within a language, missing source metadata, invalid placeholders, an unexpectedly small catalog, and a material count drop from the preceding version also fail generation. The action writes a machine-readable generation report alongside the catalog.

The initial compatibility check compares the generated catalog for Vanessa `1.2.043.28` with the current `res/steps.htm`. Exact equality is not required because the source set may legitimately differ, but every legacy pattern absent from the generated catalog must appear in the reviewed report. This makes the migration auditable instead of relying only on a minimum step count.

## Publication Workflow

Add `.github/workflows/publish-step-catalogs.yml` with scheduled and manual triggers. The workflow:

1. reads official non-prerelease Vanessa releases from `Pr-Mex/vanessa-automation`;
2. checks the existing catalog index;
3. downloads and pins the source archive for each missing requested release tag;
4. runs the generator and its validation suite;
5. updates the immutable version directory and index;
6. publishes to a dedicated `step-catalogs` branch.

The catalog branch is separate from protected `main`, contains only generated assets, and is addressed through `raw.githubusercontent.com`. A catalog path that already exists with different content causes the action to fail; released catalogs are append-only. The manual trigger accepts an exact version for bootstrap, repair investigation, or backfill. The scheduled trigger publishes newly discovered stable releases only. Workflow concurrency prevents two index writers.

Generated-branch commits use `Alexey Eremeev <48015759+alexiosus@users.noreply.github.com>` so automation does not reintroduce historical work or personal email addresses.

The default index URL is:

```text
https://raw.githubusercontent.com/alexiosus/KOTfor1C/step-catalogs/index.json
```

Publishing catalogs is independent of packaging the VS Code extension. If upstream source syntax changes, CI fails and leaves the last valid index untouched.

## Vanessa Version Resolution

Version resolution is scoped to a workspace folder and does not recursively scan the workspace.

1. Use `kotTestToolkit.steps.vanessaVersion` when explicitly configured for that folder.
2. Resolve the folder-scoped `kotTestToolkit.runVanessa.vanessaEpfPath` using the same path rules as the launcher.
3. Starting from the EPF parent directory, read `docs/Changelog.md`; the first heading matching `X.Y.Z.W` is the distribution version.
4. If no supported version marker exists, mark the version as unknown and use the fallback catalog.

Only a strict four-component numeric version is accepted, with an optional leading `v` removed. Version resolution is cached by workspace-folder URI plus the changelog modification time. Changes to the EPF path, version override, catalog index URL, or changelog invalidate the relevant entry.

For multi-root workspaces, completion, hover, and diagnostics resolve the workspace folder from the document URI. Catalogs and prepared provider indexes are cached by Vanessa version, so two folders on the same version share the parsed result while folders on different versions remain isolated.

## Runtime Catalog Service

Replace `stepsFetcher.ts` as the primary API with one `StepCatalogService` created in `extension.ts` and injected into completion, hover, and diagnostics. The service owns:

- workspace-folder version resolution;
- immutable disk cache in `globalStorageUri/step-catalogs/<index-url-hash>/<version>/`;
- index and catalog network requests with redirect, timeout, cancellation, and size limits;
- schema and hash validation;
- parsing the bundled or configured legacy HTML through a compatibility adapter;
- request de-duplication and a catalog-change event.

The two providers no longer download or parse HTML independently. They consume `BuiltInStepCatalog` and build their existing prepared completion, semantic-search, regex, and suggestion indexes once per catalog identity. Diagnostics pass the document URI when asking whether a line is known or requesting suggestions.

Startup follows a cache-first, non-blocking sequence:

1. Resolve the document's Vanessa version with a bounded number of direct file reads.
2. If a validated exact catalog is cached, use it immediately.
3. Otherwise load and parse bundled `res/steps.htm` once as the session fallback.
4. Fetch the remote index and exact catalog in the background.
5. Atomically persist a valid catalog and notify consumers to rebuild only that version's prepared indexes.

The index URL hash keeps catalogs from custom registries isolated even when they use the same Vanessa version. An exact versioned catalog is immutable, so it has no time-to-live. The small index may use conditional requests and a 24-hour freshness window. Concurrent callers share the same promises. Activation does not call the forced-refresh command and does not wait for network I/O.

## Compatibility and Settings

Add:

- `kotTestToolkit.steps.vanessaVersion`: optional exact folder-scoped override;
- `kotTestToolkit.steps.catalogIndexUrl`: catalog index URL, with the official KOT catalog as default.

Keep `kotTestToolkit.steps.externalUrl` for a custom legacy `steps.htm`, but mark it deprecated and use it only as the fallback source. Its default becomes empty so the bundled fallback does not make an unnecessary network request. Existing users who explicitly configured it retain their behavior when an exact versioned catalog is unavailable.

`kotTestToolkit.refreshGherkinSteps` becomes a single service refresh. It invalidates the index cache, retries the exact catalog for relevant workspace folders, and then causes both providers to rebuild from the same result. The command reports the selected Vanessa version, source (`versioned cache`, `downloaded catalog`, `custom HTML`, or `bundled HTML`), and step count. Automatic background failures are logged without showing repeated notifications.

The legacy HTML adapter is the only module that depends on `node-html-parser`. It converts the four columns into the same catalog model, using a synthetic source version such as `legacy-html`. Once versioned catalogs have proved reliable across supported Vanessa releases, removing HTML and that dependency can be a separate migration.

## Failure Handling

- Unknown project version: use the validated legacy fallback and log how to configure the override.
- Exact version absent from the index: use the fallback; never select latest or nearest.
- Offline or timeout with an exact cached catalog: keep the cached catalog indefinitely.
- Invalid index, hash, schema, or version mismatch: preserve the previous cache and fallback; never overwrite it.
- Invalid custom HTML: continue to bundled HTML.
- Catalog refresh while a request is in flight: cancel or supersede the old result and publish only the newest generation token.
- Workspace folder removed: release its resolver state while keeping reusable version caches.

Cache writes use a temporary file followed by rename. A failed write cannot corrupt the previous valid catalog.

## Testing

Pure Node tests cover:

- BSL lexical extraction across comments, multiline strings, omitted arguments, nested calls, and static concatenation;
- explicit failure and diagnostics for unsupported dynamic registration expressions;
- localization pairing, deterministic IDs and ordering, duplicate detection, and stable output;
- catalog and index schema validation, SHA-256 verification, version mismatch, and response-size rejection;
- Vanessa version extraction and resolution priority;
- exact-cache, offline, unknown-version, absent-version, invalid-download, and bundled-HTML fallback paths;
- one in-flight request shared by completion and hover;
- multi-root selection of different versions and reuse of equal-version prepared indexes;
- manual refresh updating both providers from one service result;
- compatibility conversion of representative and full bundled `steps.htm` rows.

The generator has a local verification command for an already available Vanessa source checkout. Network synchronization is confined to the GitHub workflow and is not part of `npm test`. Standard verification remains `npm run check`, `npm run vscode:prepublish`, and `git diff --check`.

## Rollout

Implement in four green increments:

1. Add the catalog model, validators, legacy HTML adapter, and provider conversion to the shared model without changing the active source.
2. Add folder-scoped version resolution, `StepCatalogService`, immutable cache, settings, and single-load provider integration.
3. Add the source generator, fixtures, deterministic validation, compatibility report, and local generator command.
4. Add the publishing workflow and bootstrap `1.2.043.28`; keep `steps.htm` as fallback and document how to inspect the active catalog source.

The runtime can ship only after the configured catalog URL contains the bootstrap index and catalog. Until then, all users continue through the bundled fallback without losing IntelliSense.

## Acceptance Criteria

- A project using Vanessa `1.2.043.28` resolves that exact version from the configured EPF distribution and uses the matching published catalog.
- Adding a stable Vanessa release through the workflow does not require a new extension release.
- Completion, hover, and unknown-step diagnostics share one validated catalog and do not independently fetch or parse `steps.htm`.
- Extension activation neither forces a network refresh nor waits for catalog publication.
- Cached exact catalogs work offline indefinitely; a first offline run still has bundled step support.
- Multi-root documents use catalogs matching their own workspace folders.
- A missing exact version never silently falls forward or backward to another Vanessa version.
- CI generation is deterministic, auditable for unresolved registrations, and cannot overwrite an immutable published version.
- No runtime 1C launch, EPF unpacking, BSL source download, or AI/MCP call is introduced.
- User libraries and exported scenarios behave exactly as before and remain outside this catalog.
- All project checks and catalog-generator tests pass.
