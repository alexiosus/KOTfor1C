# Properties controls and save feedback

Apply the user's 15 requested corrections on the existing ordinary-YAML/right-sidebar design. Fix the native saved-source comparison (BOM/EOL and genuine stale snapshots), keep action errors visible until dismissal/retry/source switch, and visually mark pin.

Native catalog selects replace header suggestions and base/profile action buttons. Reuse function configuration, base/profile definitions and shared groups; shared string catalogs store projects/report levels/categories under .kot with portable names. New-item options live inside selects. Guard created/selected items and paired fields against stale documents and incorrect base ownership.

Metadata actions become small inline icons. Remove duplicate Test settings wrapper and global source path/open action; put source path/open icon on Properties. Remove the two explanatory list hints. Nested rows use hover opening and fading/scrolling titles with the counter last. Tags edit their name in the row, hide deletion until hover/focus and retain drag reordering without arrow buttons. Scenario parameter records become initially collapsed details showing name/default/usage count. Show two canonical flag values.

Validate these behaviors in model/session/webview/native-boundary tests, guarded catalog/create tests, source preservation and the full prepublish gate. No release, install, commit or external corpus changes.

Completed 2026-10-14. Review additionally exposed and fixed stale settings/metadata ownership during deferred enrichment, catalog selection inventory mismatch, cancellation saving dirty metadata, and workspace ownership/configuration scope during creation. Regression tests cover those triggers.

Validation: `npm run vscode:prepublish` passed (1537 passed, 2 skipped, 0 failed), including type checks, lint and the minified extension bundle; `git diff --check` and webview JS syntax checks passed. Read-only local browser QA at 340/700 px in dark/light themes confirmed no horizontal overflow, active pin styling, collapsed parameter summaries, inline actions, native catalog/create options and a fade for overflowing nested names. The real external Drive BOM corpus was inspected without edits.
