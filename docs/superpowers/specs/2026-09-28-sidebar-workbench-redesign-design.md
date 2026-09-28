# KOT Sidebar Workbench Redesign

## Status

Proposed design for the first increment of the wider KOT interface redesign.

This increment modernizes the Activity Bar sidebar and establishes the interaction and visual rules that later editor-tab panels will reuse. Redesigning every full editor panel in the same implementation would make the change too large to verify safely, so Step Library, Infobase Manager, YAML Parameters, and Form Explorer editor-panel redesigns will follow as separate increments.

## Intent

The KOT sidebar should remain immediately recognizable to existing Test Manager users while becoming easier for a new user to understand. It must keep test selection and build operations explicit, surface scenario relationships without occupying horizontal space, and provide lightweight access to steps and infobases without turning the sidebar into a settings dashboard.

Success means:

- existing Test Manager build-selection behavior remains available and obvious;
- the sidebar contains three independently collapsible and resizable native VS Code views;
- a user can search or insert a commonly used step without opening the full Step Library;
- a user can launch or maintain a configured infobase without opening the full Infobase Manager;
- scenario relationships are visible across main and nested scenarios but can be disabled;
- no sidebar list requires horizontal scrolling;
- the sidebar does not trigger a second workspace, step-catalog, or infobase scan;
- keyboard navigation, theme support, and accessibility remain native to VS Code conventions.

## Scope

### Included

- the existing `KOT for 1C` Activity Bar container;
- Test Manager as the primary sidebar view;
- a compact unified-tree Step Library view;
- a compact Infobases view;
- relationship highlighting shared by Test Manager and the compact Step Library;
- common sidebar visual tokens and reusable row/control styling;
- commands that open the existing full Step Library and Infobase Manager editor tabs;
- test coverage for models, protocols, state, and relationship calculation.

### Excluded

- changing the build format or Vanessa launch protocol;
- putting nested scenarios into the Test Manager build-selection tree;
- replacing the full Step Library or Infobase Manager panels;
- redesigning YAML Parameters, Form Explorer, or other full editor panels;
- changing scenario or infobase persistence formats;
- changing the AI flow;
- adding background scans solely for the sidebar.

## Selected Architecture

Use three native contributed Webview Views inside the existing `kotTestToolkitContainer`:

1. `Test Manager`
2. `Step Library`
3. `Infobases`

This is preferable to embedding all three areas in one large webview. VS Code owns section headers, collapse state, ordering, and vertical resizing. A failure or slow refresh in one provider does not prevent the other views from rendering. Each provider receives only the model it needs and delegates full workflows to existing commands.

The current `kotTestToolkit.phaseSwitcherView` remains the Test Manager view. Two new view IDs are contributed for the compact Step Library and compact Infobases. Full tools continue to open as editor tabs.

## Sidebar Information Architecture

```text
KOT FOR 1C
├─ TEST MANAGER
│  ├─ Tests / Favorites
│  ├─ Search and tree actions
│  ├─ Relationship context and toggle
│  ├─ Phase → main scenario tree with build checkboxes
│  └─ Selected count, build options, Build tests
├─ STEP LIBRARY
│  ├─ Search
│  ├─ Unified source/category/definition tree
│  ├─ Insert and open-definition actions
│  └─ Open full library
└─ INFOBASES
   ├─ Active-profile infobase list
   ├─ Enterprise, Designer, and maintenance actions
   ├─ Create infobase
   └─ Open full manager
```

The default order is fixed as above. VS Code persists collapse and height state. Test Manager receives the largest initial height, Step Library receives the remaining flexible height, and Infobases starts as a compact list. All views remain independently collapsible.

## Test Manager

### Content boundary

Test Manager continues to list only main scenarios organized by `PhaseSwitcher.Tab`. Nested scenarios are definitions used by tests, not independently buildable test entries, and therefore do not receive build checkboxes in this view.

### Build selection

- A checkbox has exactly one meaning: include this main scenario in the next build.
- Phase checkboxes represent the aggregate state of their visible child tests and support checked, unchecked, and indeterminate states.
- `Select visible` applies to the current search or Favorites result.
- The selected count and build mode remain visible next to the primary `Build tests` action.
- An unchecked checkbox is sufficient. No extra `Not selected` label is shown.
- Disabled tests use a disabled checkbox and an explanatory tooltip rather than a decorative status label.

### Tabs and commands

`Tests` and `Favorites` remain local tabs. Search accepts name, code, and project text. Create, refresh, collapse, and overflow commands stay in the view toolbar. Row-level secondary actions appear on hover or keyboard focus, while essential state remains visible without hover.

### Current file and row focus

The row selected for keyboard interaction and the scenario currently open in the editor are different states:

- VS Code's normal list selection represents keyboard or pointer focus;
- the open scenario uses a blue current-file treatment, bold label, and `eye` icon;
- when the open file is nested and therefore absent from Test Manager, no main-scenario row pretends to be the current file.

## Scenario Relationship Model

### Semantics

Relationship highlighting preserves the release 2.7.1 behavior and extends it to nested scenarios.

For an open main scenario:

- its Test Manager row is marked as current;
- phases and main scenarios participating in its resolved chain are highlighted;
- nested scenarios reachable from it are highlighted in the compact Step Library.

For an open nested scenario:

- Test Manager highlights every phase and main scenario whose transitive call chain contains that nested scenario;
- the compact Step Library marks the current nested scenario;
- callers and callees in the nested-scenario graph are highlighted.

Cycles are valid input. Traversal uses visited scenario identities and never assumes the call graph is acyclic.

### Direction and depth

Direction is encoded by shape, not extra row text:

- `arrow-right-to-line`: this scenario calls the current scenario;
- `arrow-right-from-line`: the current scenario calls this scenario;
- `git-branch`: a phase or category contains related descendants;
- `eye`: the currently open scenario.

Direct and transitive relationships use the same directional icon. Transitive relationships are rendered with lower contrast. Tooltips state the direction and distance, for example `Calls the open scenario directly` or `Called by the open scenario through 2 scenarios`.

### Color

- Current/open scenario: standard VS Code blue current-selection family.
- Related rows and aggregate groups: muted purple fill, purple left rail, and purple direction icon.
- Pointer/keyboard selection: normal VS Code list selection and focus tokens.
- Modified file: amber `M` decoration with a tooltip.
- Warning and error states: standard amber and red semantic tokens.

Parent and child relationships share the same purple family. Their icons communicate direction so the tree does not become multicolored. Information never depends on color alone.

### Toggle

A pressed `git-branch` toolbar button enables relationship highlighting. It is on by default to preserve current behavior and is persisted per workspace. Turning it off removes relationship fills, rails, aggregate markers, and counts but does not alter build selection or current-file state.

When enabled, a short context line identifies the open scenario and summarizes results, for example:

```text
Open: Fill GL account
Relationships: 3 main tests · 7 nested scenarios
```

No per-row prose such as `calls current` or `called by current` is displayed. This keeps the tree narrow and avoids horizontal scrolling.

### Relationship service

Introduce a pure `ScenarioRelationshipIndex` built from the published `ScenarioCatalog` revision:

- adjacency by stable scenario identity;
- reverse adjacency for incoming calls;
- ownership from nested scenarios to main scenarios and phases;
- on-demand direct and transitive traversal;
- deterministic path/name ordering;
- cached results invalidated only when the catalog revision changes.

The index is shared by the Test Manager and Step Library sidebar providers. It does not read files or trigger scans. Active-editor changes request a lightweight relationship projection from the current cached revision.

## Compact Step Library

### Unified tree

The sidebar uses the approved unified-tree layout rather than the full panel's three-column layout:

```text
Vanessa built-in
  UI
    Tables
      And I go to the first line in "" table
Export scenarios
Nested scenarios
  Tests Environment
    And I fill GL account
Main scenarios
```

Source, category, and definition nodes share one hierarchy. Built-in Vanessa translations remain one definition with an alternate-language presentation; RU and EN category branches are not duplicated when both languages are enabled.

### Performance boundary

The view consumes the existing prepared step-library snapshot. It never scans Vanessa, project libraries, or scenarios by itself.

The compact tree does not create DOM rows for all definitions on startup:

- root and category counts are rendered first;
- definitions are projected only for expanded branches;
- search is debounced and returns a capped result projection;
- closing or hiding the view does not discard the shared catalog;
- refresh delegates to the existing catalog refresh command and displays progress locally.

### Actions

- Selecting a definition reveals its compact row state.
- `Enter` inserts into a compatible active editor.
- `Cmd/Ctrl+Enter` opens the definition when a source location exists.
- The view header contains a visible `Open full library` action.
- The full library continues to own detailed descriptions, translations, parameters, advanced filtering, and large result browsing.

The relationship toggle from Test Manager also controls relationship markers on nested and main scenario definitions in this tree.

## Compact Infobases

### Data source

The view lists infobases resolved from the active KOT profile. It consumes the same normalized profile and infobase model as the full Infobase Manager and must not parse configuration independently.

The active-profile base is indicated with a small green status dot and tooltip. This indicator means `active profile target`, not `process currently running`.

### Primary row actions

Each infobase row exposes:

- launch 1C:Enterprise;
- open Designer;
- overflow menu for maintenance actions.

The view footer exposes:

- `Open Infobase Manager`;
- `Create infobase`.

### Maintenance menu

The overflow menu groups infrequent actions:

- export database to `.dt`;
- import database from `.dt`;
- export configuration to `.cf`;
- import configuration from `.cf`;
- open additional existing commands where appropriate.

Importing `.dt` or `.cf` can replace data or configuration. Before starting, the command shows a confirmation containing the exact target base and selected source file. Export actions confirm overwrite only when the destination already exists. All operations use the existing process-launch and output-channel infrastructure; the webview never builds command lines.

Creating a base launches a focused wizard or the existing full-manager flow. The compact view does not reproduce every creation setting inline.

## Visual System

### Native VS Code baseline

The sidebar should look like a contemporary VS Code view rather than a standalone dashboard:

- use `--vscode-*` tokens for all colors;
- use native list selection, focus, input, button, and badge semantics;
- 30–32 px comfortable tree rows, with an optional compact density later if required;
- 28–30 px controls;
- 2–4 px control radii and 4–8 px bounded-surface radii;
- one-pixel dividers;
- no gradients, heavy shadows, large rounded cards, or nested card containers;
- essential actions visible, secondary row actions revealed on hover and focus;
- ellipsis truncation for long labels;
- fixed right-side decoration/action gutter;
- vertical scrolling only in sidebar trees.

The current blue and relationship purple are derived from VS Code theme tokens with theme-aware translucent fills. A fallback uses existing list and editor-highlight tokens when a theme does not define chart purple.

### Shared styles

Extend the existing common webview theme into small composable sidebar primitives rather than copying another full stylesheet:

- view toolbar;
- search input;
- tree row and indentation;
- current, related, warning, disabled, and modified decorations;
- icon button and split primary action;
- empty, loading, and error states.

Provider-specific styles define only domain layout. The change does not introduce a frontend framework.

## Data Flow

### Activation

1. Extension activation registers all three view providers without forcing their expensive data sources to load.
2. VS Code resolves a provider when its view becomes visible.
3. The provider subscribes to an existing cached service and sends the smallest initial projection.
4. Visibility changes pause UI-only work but retain shared caches.

### Active editor change

1. Resolve the active YAML or feature document to a stable scenario identity.
2. Query `ScenarioRelationshipIndex` against the current catalog revision.
3. Publish a compact relationship state to Test Manager and Step Library.
4. Each view updates classes and counts without rebuilding unrelated rows.

### Catalog or profile change

- Scenario-catalog revision invalidates relationship results and refreshes affected Test Manager and Step Library projections.
- Step-catalog revision refreshes compact Step Library counts and expanded/search results.
- Active-profile or infobase configuration change refreshes only the Infobases view.
- Hidden views may defer rendering until visible but must observe the newest service revision when reopened.

## Protocol and Safety

Every webview message uses a discriminated command type and validates identifiers, URIs, and action names in the extension host. The webviews cannot submit arbitrary executable paths or shell arguments.

Commands opening full tools delegate to:

- `kotTestToolkit.openStepLibrary`;
- `kotTestToolkit.openInfobaseManager`.

Infobase commands delegate to typed extension-host handlers. Destructive imports require confirmation outside the webview. Cancellation, launch errors, and output-log locations are reported through existing VS Code notifications and output channels.

## Error, Loading, and Empty States

Each native view owns its state independently:

- loading: small inline progress and descriptive text;
- empty Test Manager: explain how to configure or discover tests;
- empty Step Library: show refresh and full-library actions;
- empty Infobases: show `Create infobase` and `Open Infobase Manager`;
- recoverable error: retain the last valid rows when safe and show a retry action;
- unavailable active document: clear relationship highlighting without clearing build selection.

One view's error never replaces the complete KOT container.

## Accessibility and Keyboard Behavior

- Native checkboxes remain actual checkboxes.
- Tree toggles expose `aria-expanded`.
- Current and related states include accessible labels in addition to color.
- Tooltips are supplementary; essential selection and build state is visible.
- Icon-only actions have localized accessible names.
- `Enter`, arrow keys, Space, and context menus follow VS Code tree conventions as closely as Webview View APIs permit.
- Focus remains visible under every supported theme.
- Reduced-motion settings are honored; the design does not require animation.

## Testing

### Unit tests

- relationship adjacency and reverse-adjacency construction;
- main-to-nested and nested-to-main transitive projections;
- cycles, duplicate names, missing definitions, and deterministic ordering;
- view-model projections and count calculation;
- build checkbox aggregation remains independent of relationship state;
- infobase maintenance action validation and destructive confirmation routing.

### Provider and protocol tests

- all three views register under the existing container;
- providers do not request scans merely because the extension activates;
- visible views reuse current catalog revisions;
- active-editor changes update both relationship consumers;
- relationship toggle persistence is workspace-scoped;
- hidden and reopened views receive the latest revision;
- full-panel buttons invoke the existing commands;
- unknown webview messages are ignored or rejected.

### Webview behavior tests

- no horizontal tree overflow at 320, 360, and 430 px widths;
- Test/Favorites filtering and `Select visible` behavior;
- current, incoming, outgoing, transitive, and aggregate relationship classes;
- direction tooltips and accessible names;
- lazy Step Library branch rendering and capped search;
- Infobase menu grouping and command payloads.

### Manual visual matrix

- current light and dark VS Code themes;
- Windows and macOS;
- 100%, 125%, and 150% UI scaling;
- narrow and wide Sidebar widths;
- long Russian and English labels;
- mouse and keyboard-only navigation;
- relationships enabled and disabled;
- current main scenario, current nested scenario, and non-scenario active editor.

## Delivery Sequence

1. Add shared sidebar visual primitives and characterization tests around current Test Manager behavior.
2. Add `ScenarioRelationshipIndex` and verify parity with current Test Manager highlighting.
3. Restyle Test Manager without changing build semantics.
4. Add the compact Step Library native view using the existing catalog.
5. Extend relationship rendering to nested scenarios in the compact library.
6. Add the compact Infobases native view and safe maintenance commands.
7. Run performance, cross-platform, accessibility, and visual verification.

Each step must leave the extension packageable and preserve existing full-panel commands. The wider editor-panel redesign starts only after this sidebar increment is stable.

## Acceptance Criteria

1. The KOT Activity Bar container contains native, independently collapsible Test Manager, Step Library, and Infobases views.
2. Test Manager lists only main scenarios and retains its current checkbox/build behavior.
3. The open scenario is blue; related main and nested scenarios are purple; direction is communicated by distinct caller/callee icons.
4. Relationship highlighting is enabled by default, can be switched off, and does not affect build selection.
5. An open nested scenario highlights all owning phases and main tests plus related nested scenarios without infinite traversal.
6. Test Manager and compact Step Library require no horizontal scrolling at supported sidebar widths.
7. The compact Step Library uses one tree and reuses the existing prepared catalogs without duplicate scans.
8. The compact Infobases view provides Enterprise, Designer, create, DT import/export, CF import/export, and full-manager access.
9. Destructive infobase imports require explicit confirmation naming the target base.
10. Hidden views do not perform unnecessary render work, and opening the sidebar does not regress Extension Host responsiveness.
11. Existing full Step Library, Infobase Manager, build, run, and creation workflows remain available.
