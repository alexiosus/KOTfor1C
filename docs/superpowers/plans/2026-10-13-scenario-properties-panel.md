# Scenario Properties Sidebar Implementation Plan

Preserve the dirty checkout. No commits, release, installation or external Drive corpus changes.

**Goal:** Original YAML with folded service sections; headers, parameters, nesting, test settings and KOT metadata in a Secondary Side Bar view following the active editor.

**Spec:** `docs/superpowers/specs/2026-10-13-scenario-properties-panel-design.md`

## Implementation

- [x] Keep the source-preserving property model, exact UID settings linkage, document revision guards, group registry and adjacent metadata store.
- [x] Keep the compact form, stable record identities, add/remove/reorder, parameter combinations, focus drafts and serialized edit acknowledgements.
- [x] Replace the virtual text editor with `ScenarioYamlEditor`, which opens the original file and folds populated service sections while retaining the body or process steps.
- [x] Remove filesystem projection, URI normalization, mapped language/diagnostic providers and their obsolete tests.
- [x] Convert the editor webview panel to a registered WebviewView contributed to the Secondary Side Bar; use VS Code 1.106+.
- [x] Follow active source/settings/metadata tabs; retain selection on sidebar focus; clear unrelated editors; retain explicit pinning.
- [x] Reuse existing rename, base/user, group, process and creation actions against ordinary YAML documents.
- [x] Preserve native dirty edits, Auto Save and Undo. Save test commits focused form fields then saves current related documents.
- [x] Update documentation to the final YAML and sidebar workflow.
- [x] Complete the full prepublish gate, native VS Code Auto Save/Undo/sidebar/folding probe, JS syntax and diff checks.

## Validation

The earlier body-only projection implementation was removed after the user's direction changed. Independent final review was attempted earlier but unavailable due to the service usage limit; source self-review and native checks were completed.

`npm run vscode:prepublish` passed for the final design: types, lint, 1466 passing tests, 2 skipped tests, codicons and the minified extension bundle. Both webview scripts passed `node --check`; `git diff --check` passed.

A real VS Code 1.141.0 probe used an isolated temporary workspace and profile. It confirmed the original file/YAML editor, a registered Secondary Side Bar view without an editor webview tab, folded service sections with an expanded scenario body, Auto Save of typed text, Undo followed by Auto Save, and Auto Save of the ordinary document edits used by the properties form. Existing automatic metadata/nesting repair hooks were disabled in that temporary fixture to isolate document saving. The probe exited successfully; it created no feature copy and did not modify the user's Drive corpus.

The final form also exposes Fold service sections for processes. The existing autoCollapseOnOpen setting now reuses the same section selection for scenario/process YAML and YML files. Session tests cover following source/settings/metadata tabs, sidebar focus, unrelated editors, explicit pinning, and reopening the view with fresh document values. No extension installation, commit or publication was performed; the 1C compiler itself was not executed.

## Default opening follow-up

- [x] Automatically reveal properties for the active visible compiler YAML or its adjacent metadata; retain ordinary editor focus.
- [x] Initialize restored active editors and retry visible-editor lifecycle transitions; reject hidden previews and stale instances.
- [x] Add editor.autoOpenTestProperties, enabled by default, with localized settings descriptions and documentation.
- [x] Preserve existing follow/pin and dirty-document behavior; avoid reopening the text editor or redundant state acknowledgements.
- [x] Verify the five new default-opening regressions, the complete prepublish gate, and a real ordinary-file opening probe.

The final gate passed: 1471 tests passed, 2 skipped, types/lint and the minified bundle succeeded. A separate VS Code temporary-profile probe opened the original YAML with showTextDocument, without invoking the KOT editor command. Editor focus, service folding, Auto Save, Undo with Auto Save and ordinary header-edit saving passed. Visual accessibility inspection was unavailable because macOS was locked; no claim of a new screenshot inspection is made. No user project files, installation, commit or publication were changed.
