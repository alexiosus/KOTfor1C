# PhaseSwitcher Decomposition Design

## Goal

Reduce the risk and maintenance cost of `phaseSwitcher.ts` by extracting cohesive, pure Vanessa log and launch-configuration logic without changing commands, UI behavior, process execution, or persisted state.

## Scope

- Extract Vanessa run-log parsing and failure-summary construction into a pure module.
- Extract Vanessa launch JSON traversal, alias handling, parameter application, and path-value transformations into a pure module.
- Add characterization tests before moving logic.
- Keep orchestration, VS Code UI, filesystem access, process launch, and mutable provider state in `PhaseSwitcherProvider`.

## Explicit Exclusions

- Do not modify AI-related methods or their call sites.
- Do not modify `steps.htm`, steps loading, completion providers, or IntelliSense proposals.
- Do not redesign commands or webviews.
- Do not combine the extraction with behavior changes.

## Problem

`phaseSwitcher.ts` is approximately 13,000 lines and mixes provider orchestration with pure text/JSON transformations. Small changes require navigating unrelated concerns, private helpers are difficult to test, and repeated local parsing logic increases regression risk. A full rewrite would be unnecessarily risky; the safest first tranche is to move already-cohesive pure functions behind narrow APIs.

## Architecture

Create two modules with no `vscode` imports:

- `vanessaRunLog.ts`: parses a supplied log tail and returns structured scenario/step/failure information. It has no file I/O and no UI formatting side effects.
- `vanessaLaunchJson.ts`: reads and transforms plain JSON-compatible values. It has no workspace access, prompts, or file I/O.

`PhaseSwitcherProvider` remains the application service. It reads files, obtains configuration, calls the pure modules, updates state, displays messages, and starts processes. This keeps dependencies pointing inward: VS Code orchestration depends on pure domain helpers, never the reverse.

## Public Boundaries

`vanessaRunLog.ts` exports structured types and functions for extracting feature paths, line numbers, scenario names, failed-step details, and the last step location from supplied text. The main entry point accepts a log string plus the current feature/scenario identity and returns a discriminated result instead of mutating provider state.

`vanessaLaunchJson.ts` exports JSON value types plus functions to get/set a JSON-pointer path, resolve known aliases, and apply additional launch parameters to a cloned configuration. Mutation of caller-owned input is forbidden and tested.

Exact names may follow existing domain terminology during extraction, but every export must be used by `phaseSwitcher.ts` or its tests; no speculative abstraction is added.

## Migration Strategy

1. Freeze current behavior in characterization tests, including odd or legacy formats that are accepted today.
2. Copy one cohesive helper group into a pure module and make tests green.
3. Switch `PhaseSwitcherProvider` to the new functions and delete the old private methods in the same commit.
4. Run the full check before starting the next group.

## Acceptance Criteria

- `phaseSwitcher.ts` no longer contains the extracted run-log parsing or launch-JSON traversal implementations.
- New modules import neither `vscode` nor provider state.
- Characterization tests cover positive, missing, malformed, Windows-path, Unix-path, alias, and immutability cases.
- Existing commands and public extension contributions are unchanged.
- The full check and production bundle pass.
- No excluded IntelliSense, steps, or AI files change.

