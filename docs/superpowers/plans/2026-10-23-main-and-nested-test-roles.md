# Main and nested test roles implementation plan

> Execute inline under the user's explicit implementation request; use the existing workspace and preserve unrelated changes. No commit requested.

**Goal:** Test Manager lists only launchable SPPR tests; creation and conversions distinguish main and nested scenarios/processes.

**Design agreed in chat:** A linked launch-settings file defines a main test. Groups do not define launchability. Library retains reusable descriptions. Main process creation creates settings; nested process creation does not ask for a launch database or create settings. Role conversion works both ways for scenarios and processes, preserving source identity, text, references and organization. Demotion archives all linked settings as non-compiler inputs; promotion restores archived settings or uses the existing settings-creation wizard. YAML/native format conversion remains independent, in the same Conversions group.

**Architecture:** Reuse settings discovery and creation, source-pair resolution, project metadata and refresh services. Keep archive/restore file transactions in a focused module and expose one role conversion command shared by Properties, editor menus and both Libraries. Do not change standalone features.

## Work

- [x] Regression tests for launchability independent of groups; keep nested processes in Library and callable scenarios available after demotion.
- [x] Split main/nested process wizard entries and retain the existing main creation flow.
- [x] Implement saved-document guarded, reversible role conversion with collision checks and rollback; cover native pairs, multiple settings, cancellation and changed files.
- [x] Group role and format conversions in Properties, editor context menus, Library context menus and Library details.
- [x] Refresh the catalog, editor contexts, Properties and Library after conversion without re-entering the Properties action queue.
- [x] Update localization, documentation and 3.0.0 changelog. Run focused tests, npm run check, npm run compile and git diff --check.

## Constraints

- Preserve existing UIDs, source paths, feature/YAML content, callers, favorites and group/order metadata.
- Main to nested preserves settings in an archive with a non-YAML extension so compiler discovery cannot read them; do not delete authored settings irreversibly.
- Reject dirty or changed source/settings, foreign paths, ambiguous identities and restore collisions. Roll back incomplete multi-file changes.
- Do not make Parallels live-validation claims without a verified UI result.

## Verification

`npm run check` passed: 2470 total, 2468 passed, 0 failed, 2 skipped; application/tool type checks and lint passed. `npm run compile` and `git diff --check` passed. Focused tests cover launchability, nested process creation, reversible multi-settings archive/restore and rollback, native pair command binding, dirty documents/restore targets, duplicate UIDs, cancelled promotion, Properties conversion grouping and state refresh, and favorites across both role changes. Existing user test files were not converted or edited during verification. No final live Parallels acceptance is claimed; reload the Development Host to load the bundle.

## Follow-up: Parallels launch-settings archive (2026-10-24)

The role converter had a separate hard-link move from the nested/exported converter. A main → nested conversion therefore still failed with `EINVAL` while moving `test/<code>.yaml` to `.kot/launch-settings/.../*.settings.disabled`.

- [x] Reproduce the reported error by rejecting hard links at the filesystem boundary while retaining real source/settings files.
- [x] Fall back to exclusive copies for unsupported hard links during archive, restore and rollback. Preserve destination collisions and clean up a newly created copy if source removal fails.
- [x] Verify reversible conversion, mid-conversion rollback, concurrent destination preservation and a locked source with filesystem regressions.

Verification: all four new regressions failed with the original `EINVAL` and passed after the fix. `npm run check` passed: 2528 total, 2526 passed, 0 failed, 2 skipped; types and lint passed. `npm run compile` and `git diff --check` passed. The regression fixtures use real temporary files with unsupported hard links simulated at the filesystem boundary. The user's test source and launch settings were not modified, and no live conversion is claimed.
