# Library Files, Test Filters, and Artifact Freshness Design

**Date:** 2026-10-08
**Status:** Draft for user review

## Goal

Make the Test Manager and both Library surfaces feel like one product by:

- using one consistent `KOT for 1C` title system;
- adding safe file deletion and resource context menus to both Library surfaces;
- adding persistent Test Manager filters for built and running tests;
- replacing the current session-only stale flag with a portable, dependency-aware SHA-256 build manifest.

The change must preserve the current scenario runtime identity model, lazy Library loading, cross-platform workspaces shared between Windows/Parallels and macOS, and the existing filesystem safety boundary for scenario attachments.

## 1. Titles

Use these user-facing titles everywhere:

- common container: `KOT for 1C`;
- detached Test Manager: `KOT for 1C: Test Manager`;
- detached/standalone Library: `KOT for 1C: Library`;
- detached Infobases: `KOT for 1C: Infobases`.

`for` is always lowercase in English. Russian localized view names remain localized after the common `KOT for 1C` brand prefix.

The VS Code container title, view `name`, view `contextualTitle`, and full Library webview title must be coordinated so VS Code does not produce duplicated titles such as `KOT Library: Library` or `KOT Infobases: Infobases`.

## 2. Library file context menus and deletion

### Scope

The behavior applies to scenario attachment file rows in:

- the compact Library webview view;
- the full-size Library panel, including resource rows in the results and details columns.

The generated compiled `.feature` row remains openable and revealable but is not deletable from Library. Deleting build artifacts is outside this feature.

### Context menu

Right-clicking an attachment file row opens the same ordered actions on both Library surfaces:

1. `Open externally`
2. `Show in Finder` / `Show in Explorer` through the existing localized reveal label
3. separator
4. `Delete`

Directory/resource-group context menus may expose `Show in Finder/Explorer`, but deletion is limited to file leaves for this change. Existing click, drag-out, drag-in, and editor-insertion behavior remains unchanged.

### Delete flow

1. The webview sends a typed `deleteScenarioFile` message containing the owning item id and normalized relative path.
2. The extension resolves the item through the same provider-owned item lookup used by open/reveal.
3. `ScenarioFilesService` validates the relative path, rejects an empty path, confirms that the existing leaf is a regular file, and reuses the current realpath/symlink containment checks.
4. VS Code shows a modal confirmation naming the file.
5. Confirmation deletes through `workspace.fs.delete(uri, { recursive: false, useTrash: true })`.
6. The existing watcher invalidates cached children on both surfaces. The initiating surface may also clear its local branch cache immediately after success so the row disappears without waiting for the debounce.

Cancellation is silent. Failures produce the existing localized resource-action failure notification and leave the row intact. Symlinks and paths escaping the attachment root are never followed or deleted.

### Shared implementation boundary

Deletion belongs in `ScenarioFilesService` and `scenarioFilesWebviewProtocol`, not in individual panels. The two Library hosts only adapt confirmation, trash deletion, and result messages. Test Manager may reuse the protocol later, but this change does not add a delete affordance there.

## 3. Test Manager status filter

### Modes

The Test Manager has one mutually exclusive status filter:

- `All tests` — no status restriction;
- `Built tests` — scenarios with a discovered feature or JSON build artifact, whether current or outdated;
- `Running tests` — scenarios whose displayed run status is `running`, including externally tracked runs.

The mode is stored at workspace scope and restored when the view or window is recreated.

### Menu and active indication

The existing Test Manager filter menu becomes the single place for relationship display/filter controls and test-status filtering. The selected status entry is visibly checked. The title-bar filter icon uses its filled/active variant whenever either:

- a relationship-only filter is enabled; or
- the status mode is not `All tests`.

Relationship highlighting alone continues to use the established active indication.

### Composition rules

The status filter, relationship filter, and text search compose by intersection. A scenario row is visible only if it passes every enabled filter. A phase/group remains visible when at least one child is visible. Group counts and the global visible-selection summary use the actually visible scenario set, while hidden scenarios retain their checkbox selection state.

Run-artifact updates re-evaluate the filter immediately. A scenario entering or leaving `running` appears or disappears without rebuilding the entire catalog. Search highlighting and expanded-group state are preserved.

The filtering predicate and visible-count projection live in the testable shared client protocol rather than being duplicated across DOM update paths.

## 4. Dependency-aware build freshness

### Current problem

`PhaseSwitcherProvider` currently marks every artifact restored from disk as stale. It can mark current-session artifacts stale after scenario saves, but it cannot prove that a disk artifact still matches its inputs after reload or on another operating system.

### Chosen persistence model

Store a versioned `.kot-build-manifest.json` in the configured build-artifact root. This is preferred over:

- VS Code workspace state, which is not portable between Windows and macOS sessions;
- comments embedded in generated `.feature` files, which would mutate generator-owned output.

The manifest is an extension-owned sidecar and is ignored by normal feature/JSON discovery.

### Stable scenario identity

Manifest records use portable logical source identities rather than absolute runtime URIs:

- scenario YAML and scenario-owned files: path relative to the configured scenario scan root;
- workspace project definitions: path relative to the workspace folder;
- configured library definitions: profile/library-root identity plus path relative to that root.

The record also stores the scenario name for diagnostics and migration assistance, but names alone are not identity because duplicate scenario names are possible.

### Dependency closure

For each built main scenario, compute a deterministic transitive closure containing:

1. the main scenario YAML;
2. its scenario-owned test configuration under `test/`, when present and used by the build;
3. every uniquely resolved nested scenario reached through scenario calls;
4. every resolved export scenario reached from the main or nested scenarios;
5. export scenarios transitively called by included export sources;
6. every regular file below the `files` attachment folder belonging to any included main, nested, or export scenario.

Attachment traversal is recursive. A file entry includes its portable relative path and content digest, so additions, removals, renames, and content changes all change the final hash. Empty directories do not affect the hash. Transfer artifacts such as `*.kot-upload` and `*.kot-backup`, generated build output, VCS metadata, and OS noise such as `.DS_Store` are excluded.

Filesystem symlinks are not followed. If the dependency closure cannot be resolved safely or unambiguously, freshness is `outdated/unknown`, never optimistically current.

### Hash construction

Use SHA-256. The final digest is calculated over a canonical stream containing:

- manifest/hash schema version;
- sorted dependency kind;
- sorted portable logical path;
- each dependency's SHA-256 content digest.

Paths use `/` separators and stable case rules appropriate to their logical root. Hashing raw file bytes avoids locale-dependent parsing and detects every build-relevant source change.

### Manifest shape

The exact TypeScript types may evolve during implementation, but the persisted contract is equivalent to:

```json
{
  "version": 1,
  "algorithm": "sha256",
  "scenarios": {
    "scenario-root-relative-path": {
      "scenarioName": "Example",
      "source": { "root": "scenario", "path": "Group/Example/scen.yaml" },
      "builtAt": "2026-10-08T12:00:00.000Z",
      "hash": "...",
      "dependencies": [
        {
          "kind": "scenario",
          "root": "scenario",
          "path": "Group/Example/scen.yaml",
          "hash": "..."
        },
        {
          "kind": "attachment",
          "root": "scenario",
          "path": "Group/Example/files/report.mxl",
          "hash": "..."
        }
      ]
    }
  }
}
```

Manifest writes use a temporary file plus rename so interruption cannot leave partially written JSON. A successful partial build updates records for rebuilt scenarios while preserving still-discoverable records for other artifacts; records whose artifacts no longer exist are pruned.

### Freshness evaluation

On successful build:

1. discover and associate output artifacts as today;
2. compute dependency snapshots for the scenarios actually rebuilt;
3. atomically update the manifest;
4. compare the persisted and current digest;
5. publish those scenarios as current.

On startup, manual refresh, external artifact watcher refresh, or catalog/dependency-index change:

1. discover artifacts;
2. read and validate the manifest;
3. associate a record by portable scenario identity;
4. recompute current digests with bounded concurrency and a file-stat/content-hash cache;
5. mark matching artifacts current and mismatches outdated.

An artifact without a valid version-1 record is outdated until rebuilt. Malformed or unsupported manifests are ignored safely and reported to the extension output channel without preventing artifact discovery or launch.

### Incremental invalidation and performance

The manifest service owns a reverse index from dependency logical path to scenario identities. File saves, creates, deletes, renames, attachment watcher events, and project-definition index changes invalidate only affected digest-cache entries and scenarios. It must not rescan or hash the full workspace on every editor event.

Hashing uses bounded concurrency and periodically yields to the extension host. Cached file digests are keyed by logical identity plus size and modification time; cache entries are verified again when the filesystem reports a change. The service coalesces concurrent refreshes like the existing artifact refresh promise.

### UI state

The existing `stale` field remains the compatibility boundary to the Test Manager webview:

- manifest hash matches: `stale: false` and the existing ready/current presentation;
- mismatch, missing manifest, unsafe/unresolved dependency, or hash failure: `stale: true`.

No new visually loud status is required. Existing run states remain authoritative while a test is running; freshness controls whether the built artifact is presented as current before/after the run.

## 5. Architecture

Introduce a focused artifact-freshness component rather than further expanding `PhaseSwitcherProvider`. Its responsibilities are:

- portable dependency identity resolution;
- transitive dependency collection;
- recursive attachment collection;
- digest caching;
- manifest parsing, validation, migration/version rejection, and atomic writes;
- freshness comparison and targeted invalidation.

`PhaseSwitcherProvider` remains responsible for artifact discovery, run state, webview publication, and build orchestration. It supplies the current scenario catalog and receives freshness results keyed by `ScenarioRuntimeKey`.

The component may depend on the project-definition resolver/index through a narrow interface so export dependencies use the same resolution semantics as IntelliSense and relationship highlighting.

## 6. Error handling

- File deletion cancellation does nothing and shows no error.
- File deletion failure keeps the UI row and shows a localized error.
- An unreadable dependency makes only affected artifacts outdated.
- An ambiguous scenario/export dependency makes only affected artifacts outdated and records a diagnostic message in Output.
- A missing attachment that existed in the manifest changes the closure/hash and makes the artifact outdated.
- A corrupt manifest never blocks Test Manager loading or artifact launch.
- A manifest from a newer unsupported schema is preserved, not overwritten until a successful build produces a supported manifest.

## 7. Verification

Automated coverage must include:

- exact English/Russian title contributions and absence of duplicated branded titles;
- protocol rejection of invalid delete paths and empty roots;
- file-only trash deletion, cancellation, symlink escape rejection, and watcher invalidation;
- identical context-menu action ordering in compact and full Library surfaces;
- status-filter mode persistence, menu check state, active icon state, predicate composition, group visibility, and visible counts;
- deterministic hashes regardless of filesystem enumeration order;
- hash changes for scenario edits and attachment add/change/delete/rename operations;
- transitive nested and export dependency changes;
- portable path identities across Windows/macOS separators;
- old/missing/corrupt/unsupported manifests producing `stale: true`;
- matching manifests restoring `stale: false` after reload;
- atomic manifest update and preservation of unrelated valid records after partial builds;
- bounded-concurrency and cache behavior on repeated refreshes.

Final verification runs the full repository check plus syntax checks for modified webview scripts.
