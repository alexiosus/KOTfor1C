# Standalone Features Followup Implementation Plan

> **For agentic workers:** Use superpowers:dispatching-parallel-agents for the independent manager, library and completion domains; integrate and verify in this session.

**Goal:** Resolve the five reported standalone-feature defects and document the supported Vanessa feature options accurately.

**Architecture:** Keep the existing workspace feature catalog and launcher. Use the native manager presentation and native Library item models; share validated feature actions through the controller. Filter nested YAML definitions at the feature completion boundary.

**Tech Stack:** TypeScript, VS Code webviews, JavaScript, node:test.

**Spec:** `docs/superpowers/specs/2026-10-09-standalone-features-design.md`

## Global Constraints

- Work in the current branch; preserve existing edits, do not commit or publish.
- Shared groups and order stay in workspace state and do not move source files.
- Preserve authored launch JSON and existing main/nested/export behavior.
- Match the existing UI patterns, including narrow windows and keyboard actions.

## Review Focus

- Repeated identical control updates must preserve the focused DOM node and scroll position.
- Status changes while a context menu is open must preserve the menu and update disabled actions.
- Empty groups and equal group names must retain distinct catalog identities in both libraries.
- Search, favorites and snapshots must include features in both library surfaces.
- Export feature completion must exclude nested YAML calls while YAML completion retains them.

### Task 1: Manager presentation and stable interaction

**Files:** `media/standaloneFeatures.js`, `media/standaloneFeatures.css`, `media/phaseSwitcher.js/css/html`, `test/standaloneFeaturesWebview.test.ts`.

- [x] Reproduce focus/scroll and menu destruction with runtime DOM tests; observe failures.
- [x] Patch control/status updates in place and restore focus only when needed with `preventScroll`.
- [x] Use native rows, controls, status/progress, overflow, menu and expansion animation.
- [x] Verify keyboard, drag/order and changing run-state behavior.

### Task 2: Native Library integration

**Files:** Library models, snapshot service, providers, both webview scripts/styles and library tests.

**Interfaces:** Snapshot service accepts optional `standaloneFeatures` catalog; `buildStepLibrarySnapshot` accepts its snapshot as optional fourth argument. Providers use the shared validated controller for catalog mutations.

- [x] Add failing tests for native features, persisted order, empty groups, search and both surfaces.
- [x] Add native standalone items/groups and catalog invalidation to the shared model/service.
- [x] Remove separate sidebar feature panel and integrate both existing renderers.
- [x] Verify native navigation, details, favorites, groups and reordering.

### Task 3: Completion and documented options

**Files:** `src/completionProvider.ts`, focused completion tests, `documentation/blocks/standalone-features.md`.

- [x] Add failing feature/export completion tests and YAML compatibility checks.
- [x] Filter nested scenario definitions when the target document is `.feature`.
- [x] Verify optional feature sections/tags against primary Vanessa docs and state wizard limitations.

### Task 4: Integrate and verify

**Files:** `src/extension.ts`, `src/standaloneFeatureController.ts`, `src/phaseSwitcher.ts`, controller/runtime tests, localization.

- [x] Wire catalog snapshots/actions into both Library surfaces and native manager failed-step navigation.
- [x] Run relevant regression suites, then `npm run check`, `npm run compile` and `git diff --check`.
- [x] Inspect both library surfaces and manager at narrow width, including status polling, scrolling and context menus.
- [x] Review the combined diff and report verified results and documentation limitations.

## Verification evidence

- `npm run check`: type checks and lint passed; 872 tests, 870 passed, 2 skipped, 0 failed.
- `npm run compile` and `git diff --check`: passed.
- Runtime regressions cover identical manager updates, stable context menus, focused run buttons, native overflow/animation hooks, both Library renderers, feature reordering and focus across asynchronous paging. The sidebar scroll regression simulates browser scroll clamping while lazy pages are absent.
- VS Code Extension Development Host: checked a temporary corpus with 18 main scenarios and 35 authored features, then `/Users/alexeremeev/Development/1cDrive` through a temporary workspace with its actual libraries (56 main, 1835 nested, 62 exports, 1206 built-in steps and one authored feature).
- Native UI: verified manager scrolling after selecting a feature, a context menu remaining open across status updates, a single sidebar Library tree, full Library groups/details/JSON controls, consistent Ungrouped labels and no whole-feature Insert button.
- Created a temporary group from the full Library, moved the actual feature into it, observed the same group in both libraries and Test Manager, and removed the temporary group to restore Ungrouped. Source files were not changed by this check.
- Actual Vanessa/1C test execution was not performed. Optional Vanessa sections/tags are documented with primary sources; the creation wizard supplies the basic template, and advanced sections can be added through the editor actions below or a custom template.

## Follow-up verification, 2026-10-10

- Library source icons now match the sidebar in the full Library, including `file-code` for standalone features and folder icons at every category level. Root group creation and group menus precede their counters; controls are compact and borderless in the full Library.
- Standalone manager groups and feature rows use the existing hierarchy spacing. Mouse selection no longer retains hover actions in the manager or full Library; keyboard focus and run/progress controls remain available.
- Added localized feature editor CodeLens actions for descriptions, Background, Variables, feature/scenario tags, `@tree`, Scenario Outline and Examples. Variables support simple, computed, server, multiline, table and import snippets. Screenshot/video annotations are also available as actions on selected steps.
- Runtime regressions cover actual tag lines versus comments, arbitrary tag punctuation, section boundaries inside docstrings, two-space indentation, BOM/CRLF preservation, stale targets and Vanessa syntax validation. Read-only review also verified cancellation and document-version changes during prompts and editor opening leave the document unchanged.
- Native Extension Development Host: created Variables, a computed variable, Scenario Outline with a parameter-derived Examples table and `@screenshot` through the inline controls in `/tmp/kot-feature-inline-qa.feature`; verified the saved text. The full Library icons were inspected against the actual 1cDrive catalog. Source feature files were not changed by these checks.
- Screenshot/video tags now use native IntelliSense: typing `@` on a line before a real step offers the four annotations, and manually invoking completion on the step inserts its annotation above it without replacing the step. Removed the scenario-header action and the step-selection Quick Pick. Existing tags are excluded from completion; tables, docstrings and Variables are excluded as insertion contexts.
- Verified automatic `@` completion and manual Trigger Suggest in the native VS Code editor, including insertion above the existing step and exclusion of its existing `@screenshot`. Saved and inspected only `/tmp/kot-feature-intellisense-qa.feature`. A runtime regression exercises completion near the end of a 4800-line feature with 1200 scenarios.
- Final `npm run check`: type checks and lint passed; 897 tests, 895 passed, 2 skipped, 0 failed. `npm run compile` and `git diff --check` passed. Vanessa/1C execution was not performed.

## Standalone relationship follow-up, 2026-10-10

- Reference searches now include `.feature` files throughout the configured tests root. The relationship service resolves authored features by their canonical file URI independently of YAML ownership and preserves their identities in the current-editor projection.
- Opening an export projects its standalone callers; opening an authored feature projects the exports it calls. Native sidebar items expose the same relationship identity. Test Manager applies the existing relationship decoration and related-only filter to authored rows, group headers, children and counters without replacing focused rows or open menus.
- The catalog has a separate refresh event for source-only edits. Saving a changed step refreshes relationships even when feature metadata and catalog revision remain unchanged, avoiding unnecessary Library tree rebuilds.
- Regression tests first reproduced missing callers, stale relationships after source-only edits, missing native row identities, missing manager decoration/filter updates and empty filtered group contents. The tests also cover duplicate basenames, encoded editor URIs, reverse relations, catalog removal, scroll and context-menu stability.
- Native Extension Development Host on the actual 1cDrive workspace: verified the open authored feature and its group/root receive the existing purple relationship styling in Test Manager. The user's editor activity resumed during inspection; no source files were changed by QA. Export caller/reverse relations and sidebar propagation were verified by runtime tests.
- `npm run check`: type checks and lint passed; 901 tests, 899 passed, 2 skipped, 0 failed. `npm run compile` and `git diff --check` passed. Vanessa/1C execution was not performed.

## Contextual annotation IntelliSense, 2026-10-10

- Added a shared physical-source annotation model for feature files and YAML `ТекстСценария`. Header tags, screenshot/video annotations, autodoc directives, title-slide directives and export metadata are scoped to their appropriate declarations, steps or groups. Comments, docstrings, tables, Variables, Examples and YAML metadata are excluded.
- Parameterized directives and both Russian/English export metadata aliases use editable native snippets with localized descriptions. Existing aliases/annotations are omitted. Completion and lightbulb edits preserve the original step, indentation, BOM and CRLF. Blank lines at the end of a scenario are supported without breaking the YAML block.
- Project tags come from existing authored-feature and local-library catalogs with bounded cached reads and unsaved editor overlays. They remain available when built-in header tags are already present. Version and cancellation checks reject stale asynchronous completion ranges.
- Regressions were reproduced before implementation, including YAML actions, header contexts, partial directives, existing metadata aliases, project tag updates, end-of-block insertion and BOM preservation. Removed the superseded step-only completion parser so production uses the shared model.
- Native VS Code extension-host API verification in an isolated temporary profile passed: project-tag discovery from another feature, parameterized autodoc insertion preserving a literal `$Value}`, YAML completion/actions and exclusion of parameters, and both export metadata languages. Only temporary QA files were edited. Result: `/tmp/kot-annotation-native-final-result.json`.
- An independent reviewer could not run because its usage limit was reached; the integration and source boundaries were reviewed directly and verified with the tests above.
- Final `npm run check`: type checks and lint passed; 914 tests, 912 passed, 2 skipped, 0 failed. `npm run compile` and `git diff --check` passed. Vanessa/1C execution was not performed.

## Cyrillic Unicode hover follow-up, 2026-10-10

- Traced the reported U+043d/U+0430/U+0440/U+0438 hover messages to VS Code's built-in non-ASCII highlighting in an untrusted workspace. The YAML field description remains valid. VS Code's locale exception affects ambiguous-character checks, but does not suppress its non-ASCII mode, so locale-only configuration would not resolve this report.
- Added only the 66 Russian letters to `editor.unicodeHighlight.allowedCharacters` defaults for `[yaml][feature]`. Other language defaults and the non-ASCII, invisible-character and ambiguous-character switches remain unchanged. Language-specific user overrides still take precedence.
- An isolated native extension-host test reproduced the missing allowance before the change and passed afterward, including configuration for the reported `000016121/scen.yaml`, an unchanged JavaScript editor, exclusion of zero-width/bidi/Greek characters from the allowance and preservation of explicit user preferences. The source scenario was not edited. Result: `/tmp/kot-unicode-native-final-result.json`.
- `npm run check`: type checks and lint passed; 914 tests, 912 passed, 2 skipped, 0 failed. `npm run compile` and `git diff --check` passed.

## Control-flow IntelliSense, 2026-10-10

- Added native keyword completion for `Else`, `ElseIf`, `Try`, `Except` and Russian equivalents in YAML scenario text and ordinary/export feature scenarios. `ElseIf` inserts an editable condition followed by `Then`/`Тогда`. Prefix matching is case-insensitive; replacement preserves indentation and consumes the complete partial word.
- `EndIf`, `EndTry`, `EndDo` and Russian equivalents are YAML-only. Direct and semantic built-in step snippets now append closing keywords only in YAML, matching Vanessa's indentation-based feature syntax.
- Regression tests reproduced missing keywords and closing keywords incorrectly inserted in feature files before implementation. Coverage includes blank-line indentation, completion inside a partial word, existing step text, comments, tags, tables, docstrings, YAML settings and fields outside `ТекстСценария`.
- Isolated native VS Code extension-host checks passed for feature, export feature and YAML completion, native condition selection after accepting `ElseIf`, and context exclusions. Only temporary QA fixtures were edited. Result: `/tmp/kot-control-native-final-result.json`.
- `npm run check`: type checks and lint passed; 950 tests, 948 passed, 2 skipped, 0 failed. `npm run compile` and `git diff --check` passed.


## Rename across Test Manager and Library, 2026-10-11

- Added Rename to main, nested and export items in sidebar and full Library using context menus, row menus and F2. Main and nested operations reuse the existing Test Manager/editor mechanics with the selected source URI. Existing Test Manager item coverage stays intact.
- Main scenario groups in both libraries reuse the existing Test Manager group rename; UI sends a server-owned member ID, and the operation verifies the current group before changing YAML metadata. Clicking the full Library group retains keyboard focus.
- Standalone feature actions separate the Feature/Функционал title from the filename. Filename changes use a non-overwriting WorkspaceEdit and preserve group, order and chosen/adjacent launch JSON. Source placements override stale data for previously deleted destination names.
- Export rename preserves parameter names/order and actual caller tokens, updates declaration and usage metadata, and updates feature/YAML references in the current project/profile. It validates old and proposed call resolution, rejects collisions with other callable definitions, rejects dirty/stale sources and rolls back failed writes.
- Independent review identified incomplete reference scans, callable-name collisions and stale destination placements; each was reproduced with a failing regression and fixed. Rename now requests strict reference scanning while ordinary reference navigation retains tolerant behavior. Strict scans inspect saved contents for dirty callers so an unsaved removal cannot hide a saved reference.
- Native VS Code verification in an isolated temporary profile passed real title/file edits, BOM/CRLF preservation, onDidRenameFiles organization/JSON preservation, filename collisions, actual reference scanning and writes, failure propagation and dirty caller detection. Only /tmp fixtures were modified. Result: /tmp/kot-rename-native-result.json.
- Final npm run check: type checks and lint passed; 1043 tests, 1041 passed, 2 skipped, 0 failed. npm run compile and git diff --check passed. No commit or publish was performed.

## Library row actions and editor drops, 2026-10-11

- Removed item-row ellipsis buttons from sidebar and full Library while retaining group menus. Context menus now expose the same favorite, insert, copy and open actions as each surface's hover controls, alongside existing Rename and standalone organization/JSON actions. Disabled insertion and pending actions follow the same command paths as the hover controls.
- Renderer regressions failed before the change and now verify command routing for built-in/user steps, nested/export/main scenarios and standalone features in both libraries, including updated favorite labels and unavailable insertion.
- A native VS Code registration check reproduced the missing YML/feature selector. The corrected provider accepts YAML, YML and feature files and resolves the library payload before applying the separate favorites YAML guard. Native provider calls and actual editor snippet insertion passed for all three formats: `/tmp/kot-library-drop-native-result.json`.
- Actual mouse drag and visual inspection could not run because macOS was locked. Native editor API and renderer tests passed; no source files in the user's 1cDrive project were modified.
- Independent review found a readiness regression for targets outside workspace/library roots. A native check reproduced the exception before restoring the same tolerant resolver path used by hover insertion; the external-target check and all three snippet insertion formats then passed. No further menu routing/state issues were reported.
- npm run check: type checks and lint passed; 1045 tests, 1043 passed, 2 skipped, 0 failed. npm run compile and git diff --check passed.
