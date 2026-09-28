# Sidebar Workbench QA Matrix

Date: 2026-09-29

Build: `kot-test-toolkit-2.8.0.vsix`

Source revision: Task 12 worktree after `ec77a99`

## Automated performance gates

The performance checks use dependency counters instead of wall-clock limits.

| Boundary | Result |
| --- | --- |
| Active-editor relationship update performs no file or resolver I/O | Pass |
| Two Step Library consumers share one in-flight resolver generation | Pass |
| Initial compact Step Library payload contains roots, not all definitions | Pass |
| Expand/search pages never exceed the configured limit | Pass |
| Hidden Step Library invalidation performs no rebuild | Pass |
| Two infobase consumers share one in-flight collector generation | Pass |

`npm run check` passed with 537 tests total, 535 passed and 2 skipped. `vsce package` passed and produced a 1.44 MB VSIX with 77 files.

## macOS interactive verification

Environment: VS Code 1.125.0 Extension Development Host, isolated profile, dark theme. The sidebar was inspected at narrow and normal target widths around the 320/360/430 px breakpoints; exact no-horizontal-overflow behavior is additionally pinned by the webview contract tests.

| Check | Result | Evidence |
| --- | --- | --- |
| Three native sections render and collapse independently | Pass | Test Manager, Step Library, and Infobases were visible; Step Library collapsed and restored without losing state. |
| Test selection and build count remain visible | Pass | Main/Favorites controls and `Will be built: 56/56` remained available at narrow width. |
| Relationship toggle remains separate from build selection | Pass | Toggle stayed enabled while checked rows and build count were unchanged. Direction/current precedence is covered by protocol tests. |
| Compact library initial payload | Pass | Five source roots rendered without definition rows. |
| Category expansion is lazy | Pass | Expanding built-ins rendered category roots and counts, including UI, Service, Files, variables, and localized categories. |
| Search is bounded and responsive | Pass | `wait window` produced one bounded result page; no UI stall or Extension Host unresponsive warning appeared. |
| RU/EN and multiline rendering | Pass | Search results exposed both language variants through accessible labels; long rows ellipsized without horizontal sidebar scrolling. Full-library multiline/table rendering remains covered by the existing visual-library tests. |
| Open full Step Library | Pass | Opened `KOT Step Library` in an editor tab with sources, definitions, resizable splitters, and details. |
| Compact infobases | Pass | Active-profile marker, base rows, Enterprise/Designer actions, Create, row menu, refresh, and full-manager action rendered. |
| Destructive import confirmation | Pass (automated) | DT, CF, and configuration-source import paths require the typed modal confirmation before a 1C process can start. |
| Keyboard/accessibility surface | Pass | Trees, rows, toggles, actions, search, splitters, and disabled insertion targets were present in the accessibility tree with labels. |
| Dark-theme focus and selection | Pass | Focus/selection used VS Code theme tokens and current/relationship states stayed semantically distinct. |

Live screenshots were inspected during the Extension Development Host session; they are not committed because they include the user's local workspace names and infobase paths.

## Windows/Parallels verification

The running Windows 11 VM and its Visual Studio Code application were detected, but the current Parallels edition does not provide `prlctl exec`, so the newly built VSIX could not be installed or driven from this task without changing the user's installed extension through the GUI. The visible Windows instance contains an earlier extension build and is not accepted as evidence for this revision.

Status: **manual smoke test required before merge**.

Use `kot-test-toolkit-2.8.0.vsix`, then run the following matrix in the VM:

| Theme | UI scale | Sidebar widths |
| --- | --- | --- |
| Dark | 100%, 125%, 150% | 320, 360, 430 px |
| Light | 100%, 125%, 150% | 320, 360, 430 px |

For each representative combination:

1. Reload Window and confirm the three sections appear without opening a YAML file first.
2. Expand a large built-in category, search `wait window`, clear the search, and open the full library.
3. Open main and nested YAML scenarios; verify current blue, incoming/outgoing purple icons, transitive owning tests, and toggle persistence.
4. Verify Main/Favorites/search/check selection/build count remain unchanged by relationship highlighting.
5. Verify long RU/EN labels and multiline/table steps never create horizontal scrolling in the sidebar.
6. Verify the active base, Enterprise/Designer, Create, DT/CF submenu, and full Infobase Manager entry.
7. Cancel a DT/CF import confirmation; only in a disposable test base, confirm one import path and verify the named target/source.
8. Repeat expand/search/scenario switching/refresh while Developer Tools is open. There must be no `UNRESPONSIVE extension host` warning, and each catalog/infobase source must be collected once rather than once per view.

## Acceptance traceability

- Stable scenario identity and relationship traversal: relationship index/service tests.
- Build-selection independence and current/related decoration: Phase Switcher protocol and webview contract tests.
- Shared cached Step Library and infobase work: deterministic performance tests above.
- Lazy activation and bounded sidebar payloads: compact provider and workbench contract tests.
- Destructive operation safety: infobase confirmation tests.
- Existing full panels and commands: workbench registration contract plus macOS interactive verification.
- AI behavior: no AI-related source or asset is part of this redesign diff.
