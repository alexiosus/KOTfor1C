# Project parameter profiles implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Preserve existing unrelated edits; do not commit them as part of this task.

**Goal:** Isolate build/Vanessa/GlobalVars profiles and active selection per project, including a ready workshop profile and explicit legacy import.

**Architecture:** Store the existing v5 payload under a project URI-derived SecretStorage key. Read a portable project seed only when that key is absent. Preserve the legacy global payload for explicit copying through the existing profile picker.

**Tech Stack:** TypeScript, VS Code SecretStorage and webview, Node test runner.

**Spec:** `docs/superpowers/specs/2026-10-26-project-parameter-profiles-design.md` — approved approach in the user's request «реализуй второй вариант».

## Global constraints

- Keep all three profile sections together; preserve unrelated user edits and old shared profiles.
- Use the first root URI, consistently with current compilation ownership; adding/removing the first root restarts the extension host (VS Code API contract).
- No automatically inherited legacy parameters; machine settings retain their existing storage.
- Project seeds are data only; no code execution or automatic changes to a running Vanessa.

## Review focus

- Windows/UNC project identity, and opening the same folder through a workspace file.
- Queued conversion rollback must touch only the owning project's secret key.
- A malformed seed must never trigger inheritance of the old global profile.
- Reopening the workshop after editing must preserve the edits.
- Explicit profile duplication must still copy all profile sections.

## Task 1: Isolated storage and legacy import

**Files:** `src/yamlParametersManager.ts`, `test/yamlParametersProjectProfiles.test.ts`, existing profile tests, localization and manager HTML.

**Interfaces:** Project key derives from first folder URI; existing manager public loading/saving APIs remain unchanged. Add `importLegacyProfile(profileId)` for the existing profile picker.

- [x] Add failing integration tests using two manager instances, a shared keyed secret store and distinct root URIs; test reopening, active selection, global-key preservation and explicit import.
- [x] Verify failure, then implement isolated keys, reusable legacy payload parsing and import picker action.
- [x] Verify profile and conversion transaction tests; expose project ownership in the manager.

## Task 2: Clean setup and portable workshop defaults

**Files:** manager, `src/kotSetupProfile.ts`, `examples/kot-workshop/.kot/parameter-profiles.json`, setup/profile tests and demo verifier.

**Interfaces:** Absent project storage may read v5 seed; `setupProfileParameters` returns project-relative internal paths. New setup profiles use standard additional parameters and empty GlobalVars.

- [x] Add failing tests for a seeded workshop, stored overrides, malformed seed, clean setup and internal/external paths.
- [x] Implement seed loading and the workshop seed, clean setup creation and relative path handling.
- [x] Run focused tests and demo verification.

## Task 3: Documentation and final validation

**Files:** profile/project-files/setup/workshop documentation and changelog.

- [x] Document project ownership, legacy import, seed precedence and workshop readiness.
- [x] Run `npm run check`, `npm run compile`, `npm run verify:demo`, `npm run docs:check`; inspect changes and verify packaging includes the seed.
- [x] Review the change for isolation and preservation failures; record results here.

## Results

- Initial eight integration tests reproduced inheritance, cross-project overwrites and missing workshop setup before implementation. Relative-path and native-picker tests also demonstrated their missing behavior before their fixes.
- Independent review identified unsafe embedding of project-supplied strings into the webview. A failing regression reproduced closing-script markup and replacement-token corruption. All bootstrap JSON now escapes `<`, and user-data replacements use callbacks; the regression passes while preserving the original values.
- Final `npm run check`: 2593 tests, 2591 passed, two skipped, zero failures; TypeScript and ESLint passed. Initial locale-key mismatch was corrected in both language bundles before the final run.
- `npm run compile`, `npm run verify:demo` and `npm run docs:check` passed. Demo verification covers 116 local guide links; documentation verification covers 631 local links/images and 287 preserved section addresses.
- Cached VSCE file-list verification includes `examples/kot-workshop/.kot/parameter-profiles.json`. All three seed sections match the tutorial JSON configuration files.
- Final independent functional review found no remaining material issues in scope ownership, import, rollback, seed precedence or relative-path consumers. No live 1C execution was required for the storage change.
- Changes remain uncommitted together with the pre-existing working tree; unrelated changes were preserved.
