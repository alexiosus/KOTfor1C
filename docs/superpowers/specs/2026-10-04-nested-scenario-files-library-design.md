# Nested Scenario Files in Step Library Design

**Date:** 2026-10-04

**Status:** Approved

## 1. Context

Nested scenarios may own supporting resources in a `files` directory next to their
`scen.yaml`. Those resources can include MXL layouts, spreadsheets, images, and
other fixtures. Today the Step Library exposes the callable nested scenario but
does not expose its supporting files, so users must leave the library and locate
the scenario directory manually.

The feature must work in both Step Library surfaces:

- the compact sidebar webview;
- the full-size three-pane Step Library webview.

The selected visual design is an inline tree in both surfaces:

```text
Nested scenario
  Files
    Fixtures
      Input.xlsx
    Expected.mxl
```

The tree appears directly below the nested-scenario row. The full-size panel does
not move the file tree into the details pane because the two library surfaces must
share the same mental model and interaction rules.

## 2. Goals

1. Provide fast access to every file below a nested scenario's `files` directory.
2. Keep compact and full-size Step Library behavior consistent.
3. Avoid scanning all scenario resource directories during library startup.
4. Open resources in their operating-system default applications.
5. Reveal resources in Finder or Explorer for dependable outbound drag-and-drop.
6. Accept files and directories dropped from Finder or Explorer and copy them into
   the selected scenario resource directory.
7. Let dragging a resource into an editor insert the resource file name.
8. Handle file-name collisions explicitly and safely.
9. Reflect relevant external filesystem changes without refreshing the entire
   Step Library.

## 3. Non-goals

- Previewing or editing MXL, XLSX, or other binary formats inside the Step Library.
- Searching resource contents or including resource names in the global step
  search.
- Adding resource files to Step Library favorites.
- Treating resource files as callable definitions.
- Initiating a true native operating-system file drag directly from a webview.
- Managing files for built-in steps, user steps, export scenarios, or main
  scenarios in this iteration.
- Supporting external application launch for non-local URI schemes.

## 4. Platform Constraint and Outbound Drag

VS Code webviews can receive browser drag events, but an extension webview cannot
reliably initiate an operating-system native file drag. VS Code's extension API
also does not expose Electron's main-process `startDrag` capability. Therefore:

- inbound Finder/Explorer drag is implemented directly in the webviews;
- editor drag uses textual and URI-aware data where available;
- reliable outbound drag uses **Show in Finder / Explorer**, after which the user
  performs the native drag from the operating-system file manager.

The UI and documentation must not imply that dragging directly from the Step
Library into Excel, 1C, Finder, or Explorer is supported.

## 5. Resource Location

Only nested-scenario definitions are expandable. Their resource root is derived
on the trusted extension-host side from the captured YAML definition location:

```text
dirname(capturedLocation.uri.fsPath) / files
```

The webview never supplies an absolute target path. It supplies only a stable
library item ID and a normalized path relative to the resource root.

The synthetic `Files` node is shown even when the directory does not yet exist or
is empty. This preserves a discoverable drop target. The directory is created on
the first copy operation when necessary.

Definitions without a local captured YAML location do not expose `Files`.

## 6. Shared Lazy Resource Model

A shared `ScenarioFilesService` owns all filesystem behavior. Both Step Library
surfaces depend on this service rather than implementing their own readers.

The service is responsible for:

- resolving the resource root from the current library item;
- validating relative paths;
- reading one directory level at a time;
- sorting and identifying child entries;
- copying dropped files and directory trees;
- resolving collisions;
- opening files externally;
- revealing files and directories in the OS file manager;
- invalidating changed subtrees;
- owning and disposing filesystem watchers and in-progress transfers.

The existing Step Library snapshot remains lightweight. It indicates whether a
nested-scenario row may expose files, but it does not contain a recursive resource
listing.

Directory children are requested only when the user expands `Files` or a child
directory. Results are sorted as follows:

1. directories before files;
2. locale-aware ascending names within each kind.

Each entry carries only serializable presentation data:

```ts
type ScenarioFileNodeKind = 'filesRoot' | 'directory' | 'file';

interface ScenarioFileNode {
    readonly id: string;
    readonly kind: ScenarioFileNodeKind;
    readonly name: string;
    readonly relativePath: string;
    readonly expandable: boolean;
    readonly local: boolean;
}
```

Absolute URIs remain in the extension host. Stable IDs are derived from the
library item identity plus the normalized relative path.

## 7. Tree Presentation

### 7.1 Compact sidebar

A nested-scenario definition becomes expandable. Expanding it inserts a `Files`
node below the definition. Files and directories follow the existing shared tree
indentation and disclosure-arrow styles.

### 7.2 Full-size panel

The central definition list uses the same inline hierarchy. A nested-scenario row
may expand to `Files`, directories, and files. The selected scenario continues to
drive the details pane; selecting a file does not replace scenario details with a
second, incompatible file browser.

### 7.3 Common row behavior

- One click selects a file row or expands/collapses a directory control.
- Double-clicking a file opens it with the OS default application.
- Files and directories expose **Show in Finder / Explorer**.
- Files and directories use VS Code file/folder iconography where available.
- Files have no favorite control and no callable-definition actions.
- Empty roots show an unobtrusive empty-state message while remaining droppable.

Expanded state is maintained independently by the compact and full-size surfaces,
while resource data and behavior remain shared.

## 8. Drag and Drop

### 8.1 Dragging into an editor

File rows are draggable. Their `text/plain` payload is the base file name only,
for example:

```text
Expected.xlsx
```

The payload intentionally excludes an absolute path. A URI list may also be
provided for VS Code targets that understand it, but inserting the file name is
the required behavior.

Directory rows do not insert a path into the editor.

### 8.2 Dropping from Finder or Explorer

Valid drop targets are:

- the nested-scenario row;
- its `Files` node;
- any child directory.

A drop onto the scenario row or `Files` copies into the resource root. A drop onto
a directory copies into that directory. Dropped directories are traversed
recursively using Chromium's directory-entry API when available. If the runtime
cannot enumerate a dropped directory, the operation rejects that directory with
a clear message while still processing independent dropped files.

The webview first sends the relative entry manifest. The extension host validates
the target and resolves conflicts before accepting content. File content is sent
in bounded chunks rather than one base64-encoded message so large spreadsheets and
layouts do not create excessive peak memory use.

Each transfer has an ID and supports:

- start with expected size;
- ordered chunks;
- completion and verification;
- cancellation and cleanup.

Content is written to a temporary sibling file. The final target is created or
replaced only after all chunks arrive successfully.

## 9. Conflict Resolution

When a target file already exists, the extension displays:

- **Replace** — atomically replace the existing file after a successful transfer;
- **Save copy** — select the first available name such as `Expected (1).xlsx`;
- **Skip** — leave the existing file unchanged and continue the batch.

If a dropped directory already exists, directory contents are merged. File
conflicts inside the merged tree are resolved individually using the same prompt.
Canceling a prompt skips the current conflict rather than deleting or rolling back
already completed independent files.

## 10. Validation and Safety

The extension host is the authority for every filesystem mutation.

Before reading or writing, it must:

1. resolve the current library item again rather than trusting stale webview data;
2. confirm that it is a nested scenario with a local YAML location;
3. normalize the supplied relative directory and entry path;
4. reject empty file names, absolute paths, drive-qualified paths, `..` segments,
   NUL bytes, and paths that escape the resource root;
5. reject writes through symbolic links that resolve outside the resource root;
6. create only the required directories;
7. clean up temporary files on failure, cancellation, or panel disposal.

The implementation must not overwrite a target before the user has chosen
**Replace** and the replacement transfer has completed.

## 11. External Open and Reveal

Double-clicking a local file calls `vscode.env.openExternal` with its file URI so
the operating system selects Excel, 1C, or another associated application.

**Show in Finder / Explorer** uses VS Code's reveal-in-OS facility for both files
and directories. The label is localized for the current platform where practical.

For a non-`file` URI, external-open and reveal actions are disabled. Invoking them
through a stale UI state produces a short explanation rather than attempting to
convert the URI to an invalid local path.

## 12. Refresh and Watchers

The service caches only directory levels that have been requested. A successful
copy invalidates and refreshes the changed directory branch, not the entire Step
Library snapshot.

An expanded resource root may own a debounced filesystem watcher scoped to that
root. Changes from Finder, Explorer, or an external application invalidate the
affected expanded branch. Watchers are reference-counted across the two library
surfaces and disposed when no open surface needs them.

Collapsing a node may release child data from the presentation layer, but the
service may retain a small bounded cache. Closing a panel cancels its pending
requests; deactivating the extension disposes every watcher and transfer.

## 13. Webview Protocol

Both webviews use the same message concepts even if their existing envelopes
differ:

- request directory children;
- receive directory children or a scoped error;
- open resource externally;
- reveal resource in OS;
- announce an inbound drop manifest;
- receive accepted entries and resolved destination names;
- send transfer chunks;
- complete or cancel a transfer;
- receive subtree invalidation.

Messages identify a scenario by current presentation/library item ID and a
relative path. No message may contain an authoritative absolute destination.

Requests are versioned or tagged with a request ID so stale replies can be ignored
after refresh, collapse, or panel disposal.

## 14. Error Handling

- A missing `files` directory is treated as an empty root, not an error.
- A directory read failure produces an inline retry state for that branch.
- One failed dropped file does not abort independent files in the same batch.
- Invalid or stale scenario IDs are rejected without filesystem mutation.
- Interrupted transfers remove temporary files.
- External-open failures surface a localized notification containing the resource
  name but not an unnecessary full path.
- Watcher errors fall back to explicit subtree refresh after extension-owned
  operations.

## 15. Testing

Pure and service-level tests cover:

- resource-root derivation from a nested YAML location;
- absence of resource support for other definition kinds;
- lazy one-level enumeration;
- directories-first/name sorting;
- stable IDs and normalized relative paths;
- rejection of traversal, absolute, drive-qualified, and symlink-escape paths;
- empty/missing root behavior;
- recursive dropped-directory manifests;
- chunk ordering, size validation, cancellation, and temporary-file cleanup;
- replace, save-copy, and skip conflicts;
- merged directory conflicts;
- external open and reveal for local resources;
- disabled behavior for non-local resources;
- watcher invalidation and disposal;
- compact and full-size protocol parity;
- editor drag text containing only the base name;
- no eager recursive filesystem reads during initial Step Library construction.

Webview contract tests verify that both surfaces render the same node kinds,
support the same targets and actions, and preserve existing scenario insertion,
navigation, paging, search, and favorites behavior.

## 16. Delivery Sequence

1. Add the pure resource path and node model.
2. Add the shared lazy service and unit tests.
3. Extend compact sidebar protocol/model/rendering.
4. Extend full-size panel protocol/model/rendering.
5. Add open/reveal actions.
6. Add editor drag payloads.
7. Add inbound manifest, conflict workflow, and chunked copy.
8. Add scoped watchers and lifecycle cleanup.
9. Add localization, contract coverage, and end-to-end verification.

