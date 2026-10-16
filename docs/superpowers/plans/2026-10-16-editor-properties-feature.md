# Editor menus and feature Properties implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Apply the user's five editor/Properties requests, including the feature Properties scope explicitly approved in chat.

**Architecture:** Keep F12 as standard navigation and retain existing command IDs for compatibility. Extend the existing Properties webview with a separate feature model/controller/view, reuse native documents, standalone organization and the Library favorites service, and redirect generated features to their YAML source.

**Tech Stack:** TypeScript, VS Code APIs, existing vanilla webviews and node:test.

**Spec:** User-approved scope: feature title/description/tags, standalone group and launch JSON, scenarios and structural actions in the same Properties sidebar; generated feature → source YAML. Editor action visibility is independent for YAML and feature. Add favorites and improve the empty state.

## Global constraints

- Work in the current branch; no automatic commit/push for this follow-up.
- Preserve command IDs, shortcuts and command-palette discoverability.
- One KOT editor submenu; use menu-specific titles without `KOT -` while preserving palette titles.
- Existing `editor.showActionButtons` remains a compatibility fallback for new per-format settings.
- All feature edits use ordinary native documents with version checks, Undo, Auto Save, BOM/EOL preservation and no temporary files.
- Favorites must remain identical to Library favorites; no second persistence model.
- No edits to compiled feature text through Properties. Resolve its source; ambiguous mapping must not silently pick a test.

## Review focus

- Switching YAML/feature/custom-editor tabs, pinning and delayed operations cannot edit the previous document.
- Document changes invalidate old field positions; stale UI actions fail safely and report persistent errors.
- Exported scenarios preserve caller arguments when renamed; reuse the existing rename command rather than replacing a header blindly.
- Standalone group/JSON controls appear only for catalogued standalone features, with existing project ownership checks.
- Existing settings, favorites and command shortcuts remain compatible.

### Task 1: Editor menu and action visibility

Files: package.json, package.nls*.json, src/editorActionControls.ts, src/extension.ts, editor menu/settings tests.

- [x] Add regression tests for one KOT submenu, concise menu titles and independent YAML/feature settings with legacy fallback.
- [x] Implement, preserving the specialized compiled-feature navigation command and compatibility IDs.
- [x] Run the focused tests.

### Task 2: Shared favorites and empty state

Files: src/scenarioPropertiesPanel.ts, src/stepLibraryFavorites.ts integration, media/scenarioProperties*, Properties tests.

- [x] Test add/remove favorite, external favorite updates, tab switching and empty-state layout.
- [x] Attach the shared favorite adapter to Properties, render a stateful star and style an accessible empty state.
- [x] Run the focused tests.

### Task 3: Feature model/controller

Files: new src/featurePropertiesModel.ts, src/featurePropertiesController.ts and corresponding tests; existing feature rename/structure helpers.

- [x] Test structural fields and edits with RU/EN, docstrings, comments, BOM/CRLF, stale versions and source changes.
- [x] Implement title/description/tags/scenario models, native-document actions, standalone organization/JSON and existing feature-structure command reuse.
- [x] Run the focused tests.

### Task 4: Feature view and native lifecycle

Files: new media/featureProperties.js, existing scenarioPropertiesPanel/editor integration/webview assets, src/extension.ts, src/phaseSwitcher.ts and native/webview tests.

- [x] Test feature forms, actions, queued edits, pin/save, generated-feature redirection and clearing on unrelated tabs.
- [x] Implement the agreed UI in the existing sidebar; use the same style, action buttons and favorite service as YAML Properties.
- [x] Run the focused tests.

### Task 5: Documentation and validation

- [x] Update relevant documentation and the current 3.0.0 changelog for shipped behavior only.
- [x] Run npm run vscode:prepublish, diff checks and an independent targeted review; fix material findings.
- [x] Report the F12/compatibility distinction, settings names, delivered Properties features and verified test results.

Implementation notes: user requested Save, Run, favorite, pin in this order in the header, and separate collapsible Launch JSON / Feature blocks sections. Independent review found and regression tests cover positional queue versions, external draft conflicts, canonical acknowledgements, follow-after-explicit-open, section aliases and unpinning deleted sources.
