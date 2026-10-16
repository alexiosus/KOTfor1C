# Standalone Features Implementation Plan

> **For agentic workers:** Use superpowers:dispatching-parallel-agents for the independent catalog, creation and presentation domains; integrate and verify in this session.

**Goal:** Discover, organize, create and run independent Vanessa feature tests in Test Manager and Library.

**Architecture:** A shared workspace catalog owns discovery and persisted organization. A shared webview controller/component presents it in both sidebars. Existing Test Manager execution tracks feature URI identities alongside compiled scenario artifacts.

**Tech Stack:** TypeScript, VS Code extension API, JavaScript webviews, node:test.

**Spec:** `docs/superpowers/specs/2026-10-09-standalone-features-design.md`

## Global Constraints

- Work in current branch `codex/reliability-foundation`; do not commit or publish.
- Group/order changes do not modify test files.
- Preserve authored launch JSON; apply launch overrides in runtime copies.
- Keep existing main/nested/export behavior and localization.

## Review Focus

- Same filenames under different directories keep separate groups, JSON and status.
- Empty user groups survive refresh and missing files do not break other tests.
- External test roots are discovered and changes refresh both sidebars.
- Export-library and compiled artifacts do not appear twice.
- JSON with broad selectors launches only the requested feature, retaining unknown custom values.

### Task 1: Catalog and persisted organization

**Files:** `src/standaloneFeatureModel.ts`, `src/standaloneFeatureService.ts`, corresponding tests.

**Interfaces:** `StandaloneFeatureService.getInstance(context)`, `onDidChange`, `ensureReady()`, `refresh()`, `setCompiledFeaturePaths(paths)`, `find(id)`, group mutations, `moveFeature(id, groupId, beforeId?)`, `setLaunchJson(id, jsonPath)`; snapshot `{features, groups, revision}`; feature `{id, uri, name, title, relativePath, language, groupId, order, jsonPath?}`; group `{id,name}`. Ungrouped id is empty string.

- [x] Write behavior tests for discovery classification, stable URI identity, groups and reordering; run and observe failure.
- [x] Implement model and service with workspace state and file/root invalidation.
- [x] Run focused tests and verify persistence/exclusions/duplicate names.

### Task 2: Feature creation and profile JSON

**Files:** `src/featureCreator.ts`, `src/featureTemplate.ts`, `src/standaloneFeatureLaunch.ts`, `src/yamlParametersManager.ts`, corresponding tests.

**Interfaces:** `createFeature(context): Promise<Uri | undefined>`, `generateFeatureJson(context, featureUri): Promise<Uri | undefined>`, pure template/JSON functions. Profile retrieval must not change active profile.

- [x] Write failing tests for supplied ru/en templates and custom placeholders.
- [x] Implement feature creation with safe destination handling and optional supported sections.
- [x] Write failing JSON tests for single-file targeting, aliases, profiles, global/custom values.
- [x] Implement generation using profile selection, same-stem JSON and safe overwrite prompt.
- [x] Run focused tests.

### Task 3: Shared presentation and Library integration

**Files:** `src/standaloneFeatureController.ts`, `media/standaloneFeatures.js`, `media/standaloneFeatures.css`, `src/stepLibrarySidebarProvider.ts`, `media/stepLibrarySidebar.js`, corresponding tests.

**Interfaces:** Controller manages shared actions, posts `{command:'standaloneFeatures',snapshot}` and handles `{command:'standaloneFeatureAction', action, featureId?, groupId?, beforeId?}`. Library services accept optional standalone catalog/controller. Shared component is mounted in `#standaloneFeatureTree`; receives run artifacts from Test Manager.

- [x] Write failing protocol/controller tests; implement validated action routing.
- [x] Implement shared group tree, search, drag ordering and context/keyboard actions.
- [x] Wire Library provider lifecycle and creation menu.
- [x] Run focused tests.

### Task 4: Test Manager execution and extension wiring

**Files:** `src/phaseSwitcher.ts`, `src/extension.ts`, `media/phaseSwitcher.html`, `media/phaseSwitcher.js`, `package.json`, localization and documentation.

- [x] Write a failing integration test proving an independent feature can reach run/status logic without a main scenario.
- [x] Wire discovery exclusions and shared controller into Test Manager and Library.
- [x] Register create/generate commands and add localized settings/menu entries.
- [x] Reuse existing launcher with URI-keyed independent artifacts, preserving states through refresh.
- [x] Verify statuses/log controls, launch selection and source JSON preservation.
- [x] Run `npm run check` and `npm run compile`; inspect results and complete review.

## Verification

Completed in the requested current branch without commits. `npm run check` passes type checks, lint and the full suite; `npm run compile` succeeds. Browser preview checked both narrow trees with long labels and scrolling. Review regressions cover launch JSON business data, missing TestClient settings, URI encodings, compiled exclusion lifecycle and failures before later successful scenarios. Real 1C/Vanessa execution was not run.
