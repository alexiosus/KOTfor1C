# Infobases alignment and conversion staleness

Work inline in the existing branch; preserve unrelated changes and version 3.0.0. No commit requested.

## Changes

- [x] Use the same grid gutter for base/client runtime markers, align markers with the first name line, and indent client names by one tree level. Inherit the Test Manager `kot-icon-button` style instead of filled secondary buttons.
- [x] Reproduce missing build invalidation after conversions that write files outside editor save events. Forward changed source URIs from format, role and callable conversions through the shared refresh command.
- [x] Capture transitive callers before discarding the old catalog, then mark current artifact keys stale after refresh. Retain unrelated test states and propagate changes for removed source paths and rewritten callers.
- [x] Check the actual sidebar assets in a browser fixture and run focused conversion regressions. Update user documentation and changelog.

## Evidence

The browser fixture uses the production sidebar script, protocol, shared CSS and Infobases CSS. Initially the base marker was at x=36 and client markers at x=30, with name positions x=45 and x=47. After the change all markers are at x=36, client names at x=63, and every marker starts 6 px below its name line top. Buttons have transparent backgrounds and 0 px borders; keyboard focus reveals the action group. No production infobases or clients were changed for this check.

The regression starts with a Nested → Middle → Main dependency chain, removes the old graph during refresh and changes the main source URI from scen.yaml to meta.yaml. The resulting artifact is stale under the new URI; an unrelated passed test remains unchanged. Command regressions cover changed source paths in all conversion directions; cancelled conversions do not refresh artifacts. The four missing-invalidation checks failed before the fix and all 51 focused tests passed after it.

Full verification: `npm run check` passed (2529 total, 2527 passed, 0 failed, 2 skipped), including application/tool type checks and lint. An obsolete source-text assertion requiring vertically centered markers was removed; the intended geometry was checked in the browser. `npm run compile` and `git diff --check` passed. Windows DevHost acceptance was not repeated because the preceding attempt could not deliver input through Parallels; the new bundle requires a DevHost reload.

## Follow-up: client marker placement and ordinary source saves

- [x] Keep the child label indented, but move its marker into the same indented gutter: browser measurements now show base marker/name at x=36/45 and child marker/name at x=54/63, with the same 3 px gap after each dot. Production sidebar assets were checked in a 340 px browser fixture.
- [x] Separate an unreadable Vanessa execution state from a detached MCP session. Preserve the last confirmed inventory through a same-session polling failure or busy-run race; confirmed inventory updates, disconnect and generation changes still clear old connection indicators. Regression covers both saved and remote-only clients.
- [x] Track ordinary saves of native `scen.feature`. Capture the existing reverse dependency chain before updating descriptors and invalidate compiled callers.
- [x] Track exported feature saves, including libraries outside compiler roots. One reference-service call follows export-to-export chains with cycle protection, then the existing scenario/process relationship graph marks compiled callers stale. A real reference scanner regression covers native fragments and legacy YAML and confirms reuse of unchanged caller contents. Unrelated artifacts remain current.

Verification: `npm run check` passed (2542 total, 2540 passed, 0 failed, 2 skipped), `npm run compile` and `git diff --check` passed. Live MCP execution in Windows was not repeated; reload the DevHost to use the rebuilt extension.

Follow-up alignment: disclosure arrows and runtime dots are now centered against the entire two-line row, instead of its name line. The disclosure stays transparent on hover and does not shift when pressed; keyboard focus remains visible. Browser measurements confirmed identical row/arrow/marker centers (28 px for the base and 72/116 px for clients). Actual pointer hover reported a transparent background, 0 px border, no outline and no shadow. This follow-up changes CSS only; `git diff --check` passed.

Follow-up action hover: a translucent theme color reproduced the extra rectangular plate before hovering individual buttons. The action groups inherited the row background and painted its alpha twice. Base and client action groups now stay transparent. Browser verification confirmed both buttons are transparent with 0 px borders and no outline while the pointer is over the row; hovering the menu button highlights only that button, leaving its sibling transparent. `git diff --check` passed; CSS-only change.
