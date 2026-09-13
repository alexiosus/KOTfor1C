# Reliability Foundation Design

## Goal

Make the current `main` branch reproducibly buildable and type-safe before deeper scenario-index and activation-performance work begins.

## Scope

- Add the missing build dependency and a real automated test command.
- Make packaging depend on type checking, linting, and unit tests.
- Resolve every TypeScript diagnostic present at the `d8c21f6` baseline without suppressing diagnostics or loosening compiler settings.
- Fix the confirmed Form Explorer error-path `ReferenceError` and the AI prompt `ReferenceError` as part of the type-safe repairs.
- Add a pure, unit-tested scenario-reference matcher and use it from navigation so all supported Gherkin keywords, including the real `Given` corpus case, are found.
- Replace built-in executable launches that unnecessarily invoke a shell with argument-array process APIs.
- Upgrade `uuid` beyond the audited vulnerable range.

## Constraints

- The 1C:Drive YAML corpus is read-only and is used only for compatibility checks.
- No large `PhaseSwitcher` split, YAML parser replacement, activation redesign, SecretStorage migration, or duplicate-name index redesign belongs in this increment.
- User-configured command templates intentionally remain shell commands; only built-in launches are hardened.
- Existing VS Code and 1C user workflows must remain compatible.

## Architecture

Use Node's built-in test runner with esbuild compiling small TypeScript unit tests. Keep new parsing logic in pure modules without `vscode` imports so it can run outside Extension Host. Treat `tsc --noEmit` as the regression test for API-contract and undefined-variable defects, and add focused behavioral tests where the change affects parsing or process arguments.

## Acceptance Criteria

- A clean checkout can install dependencies and run `npm run check` and `npm run vscode:prepublish`.
- `tsc --noEmit` reports zero diagnostics.
- `npm test` executes real tests and returns a non-zero exit code for a failing assertion.
- Reference matching finds `Given I change barcode scanning action` as well as Russian and English call keywords.
- Built-in MXL and 1C process launches do not use a shell.
- The full 1C:Drive corpus remains unchanged.

