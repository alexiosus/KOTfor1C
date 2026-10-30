# SPPR defaults and KOT integration implementation plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task by task.

**Goal:** Make the default compiler profile sufficient for KOT discovery, editing, launch and diagnostics, preserving explicit saved choices.

**Architecture:** Keep compiler defaults and list parsing in pure helpers. Initialize scan roots from the active profile before discovery starts. Present model database catalog health separately from editable values and save validation.

**Tech Stack:** TypeScript, VS Code extension API, Node test runner, vanilla webviews.

**Spec:** User-approved audit and subsequent clarification about Libraries in this conversation.

## Constraints

- Preserve explicit false, empty values, aliases and custom paths in existing profiles.
- Do not duplicate Vanessa's built-in library or enable Drive-only SplitFeatureFiles globally.
- Keep non-active profile reads free of scan-root side effects.
- Continue in the existing checkout; it contains the user's ongoing changes.
- No commits, deployment or external project changes are part of this request.

## Review focus

- Multiple library paths, including Windows drive paths and literal colons on macOS.
- Explicit empty Libraries overriding VanessaLibraries and Additional priority.
- Existing profiles with custom report folders or disabled optional outputs.
- Startup with saved profile roots differing from the cached scan roots.
- Missing, invalid or empty model DB YAML; no credentials in UI messages.

### Task 1: Profile defaults

Files: src/yamlParameterDefaults.ts, src/yamlParametersManager.ts, test/yamlParametersDefaults.test.ts, test/yamlParametersCompilerPolicy.test.ts.

- [x] Add failing tests for explicit ExternalMode/CreateJson/CreateJUnit/CreateModellingXML, runtime report paths, empty Libraries and saved-value preservation.
- [x] Implement defaults shared by profile creation and absent-value upgrades; preserve aliases and explicit user values.
- [x] Run focused tests.

### Task 2: Library roots

Files: src/compilerBuildParameters.ts, src/projectLibraryRoots.ts, test/compilerBuildParameters.test.ts, test/projectLibraryRoots.test.ts.

- [x] Reproduce pipe-list and priority mismatches with failing tests.
- [x] Use strict compiler pipe lists for SPPR Libraries, preserving literal POSIX colons. Keep separate UI parsing for Additional values.
- [x] Run focused tests and verify completion/navigation consume the resolved roots.

### Task 3: Startup scan roots

Files: src/scenarioScanRoot.ts, src/extension.ts, src/yamlParametersManager.ts, test/scenarioScanRoot.test.ts.

- [x] Test initialization with active ScenarioFolder/ProcessFolder/TestFolder and cached legacy roots.
- [x] Share the fallback root and initialize from the active profile before constructing discovery services.
- [x] Run focused tests; retain side-effect-free inactive profile reads.

### Task 4: Model DB health and documentation

Files: src/yamlParametersManager.ts, src/compilerModelDbStatus.ts, media/yamlParameters.js, media/yamlParameters.html, localization bundles, tests, documentation/blocks/parameters-manager.md.

- [x] Add failing tests for missing, malformed, empty and usable model DB catalogs, without exposing passwords.
- [x] Show current catalog health and missing profile mappings; refresh on profile edits and catalog file changes without blocking autosave.
- [x] Document defaults, automatic runtime parameters and additional library behavior.
- [x] Run npm run vscode:prepublish and review changes against this checklist.

## Execution ledger

- Ruling: Execute immediately in this conversation; the user explicitly authorized all audit corrections.
- Ruling: Preserve all explicit existing values. Add only missing defaults, except report aliases suppress their equivalent defaults.
- Ruling: Upgrade stored profiles to schema 5 on the next save, so deleted optional rows stay deleted afterwards.
- Ruling: Catalog health checks selected database IDs and whether their profiles exist, without rescanning all scenario YAML files on each keystroke.
- Fresh review found literal-colon and absent-Libraries priority mismatches, plus reset/delete health refresh gaps; added regression cases and corrected all three.
- Initial full prepublish passed: 1922 tests (1920 pass, 2 skipped), typecheck, lint and bundle. Final rerun follows the review fixes.
- Final prepublish passed after review fixes: 1926 tests (1924 pass, 2 skipped), typecheck, lint and production bundle; node --check for the webview and git diff --check also passed.
