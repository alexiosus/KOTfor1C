# First run and settings implementation plan

> **For agentic workers:** Use superpowers:executing-plans for inline implementation. Track progress in the plan workspace.

**Goal:** Deliver the approved KOT settings page and first-run wizard with real VS Code configuration and safe project setup.
**Architecture:** A configuration draft service validates manifest-backed values and detects conflicts. A read-only project inspector and guarded setup service feed a CSP-protected webview. Existing profile, catalog, platform and Vanessa services remain authoritative.
**Tech Stack:** TypeScript, VS Code Webview API, existing Node tests, plain browser JS/CSS.
**Spec:** docs/superpowers/specs/2026-10-24-first-run-and-settings-design.md

## Global constraints

- Keep all existing configuration IDs, defaults and enum values; all 83 settings are represented.
- Settings entry opens settings only. An explicit Start setup action opens/restarts the wizard. A native Settings button remains available.
- Preserve UID, unknown fields, profiles, source format and unsaved documents; inspection must not migrate files.
- Use native pickers; relative project paths when supported, absolute machine paths otherwise.
- Work in the existing codex/reliability-foundation checkout with its uncommitted design/demo/terminology changes; do not reset or fold unrelated changes into task commits.
- Version remains 3.0.0. Russian and English UI. No new network dependencies.

## Review focus

- Multi-root writes must affect the selected resource and retain other scopes.
- External edits and partial failures must not cause stale overwrites or lose drafts.
- Setup inspection, cancellation and restricted mode must leave project files intact.
- Webview messages cannot execute arbitrary commands or write paths outside the reviewed plan.
- Packaged demo and UI assets must work after installing VSIX, without docs/prototype dependencies.

### Task 1: Configuration and path contracts

Files: src/kotSettingsModel.ts, src/kotSettingsSession.ts, src/kotSettingsPaths.ts, media/kotSettingsModel.json, test/kotSettingsSession.test.ts.
Produces: manifest-backed schema/presentation, scope snapshots, validated conflict-checked updates, portable picker values.
- [x] Write failing tests for inherited reset, wrong-type/enum/range rejection, changed baseline, partial failure and Windows/multi-root path rules. Run and observe failures.
- [x] Implement services, retain secret values in host memory, run focused tests and types.

### Task 2: Read-only project inspection and migration boundary

Files: src/kotProjectSetup.ts, src/projectSetupGate.ts, project library integration/store, native catalog registration; test/kotProjectSetup.test.ts and store regression tests.
Consumes: Task 1 portable paths. Produces: bounded cancellable inspection, explicit setup progress and migration gate.
- [x] Write failing tests: native pairs count once, exports excluded from tests, excluded/symlink folders skipped, no writes during inspection or gated migration.
- [x] Implement inspection and defer automatic migration until the reviewed setup is applied. Verify existing metadata behavior remains intact outside the gate.

### Task 3: Real settings panel

Files: src/kotWorkspacePanel.ts, media/kotWorkspace.js/css, extension entrypoints and localization.
Consumes: Tasks 1–2. Produces: settings-only entry, native Settings action, selectors, draft/apply/conflicts, allowlisted existing managers, keyboard-accessible help.
- [x] Add meaningful protocol/controller tests before implementation.
- [x] Implement panel and settings controls matching approved prototype; test lifecycle, scope and hostile messages.

### Task 4: Setup, demo and readiness

Files: setup services, panel, yamlParametersManager profile API, extension activation, package contributions/docs.
Consumes: Tasks 1–3. Produces: four routes, real inspection, explicit apply plan, new/example project, profile selection without implicit overwrites, runtime checks/preparation, interface tour, folder-scoped resume.
- [x] Test no-overwrite creation, changed source rejection, trust/cancel, successful retry and separate profiles.
- [x] Implement actions using existing platform/Vanessa services; persist progress without credentials. Route first example appropriately.

### Task 5: Integration and review

- [x] Run npm run check, npm run compile, npm run verify:demo and package asset checks. Fix failures.
- [x] Exercise settings and wizard in VS Code DevHost and/or webview bridge fixture; verify native-settings entry and settings-only opening.
- [x] Fresh review of complete change (single reviewer); address material findings and reverify affected behavior.
- [x] Update changelog and user docs; report actual validation and any platform-specific live-check limitations.

Validation: npm run check (2568 total, 2566 pass, 2 skipped), compile, verify:demo and package asset listing. Live macOS DevHost covered settings-only entry, native Settings, fixed navigation/right-only scroll, actual read-only discovery and relative path picker. Windows service preparation is connected to the existing service, but not live-tested in this run.
