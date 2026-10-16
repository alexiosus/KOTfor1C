# Standalone feature files

Support authored `.feature` tests alongside the existing main, nested, export scenarios and steps in the current branch. Test Manager and Library share an independent feature section, persisted groups and file order. Grouping changes presentation, not file locations or Gherkin contents.

## Catalog and organization

Scan the configured test/scenario directory, including an absolute external root, for `.feature` files. Exclude export-only library features and the compiled feature artifacts already represented by main scenarios. Use file URIs as stable identity so equally named files remain distinct. Show the Gherkin feature title with filename/path context. Files newly discovered belong to Ungrouped. Preserve empty user groups; deleting a group returns its files to Ungrouped. Refresh after file create/change/delete, scan-root changes and artifact changes. Save organization in workspace state.

## Presentations

Test Manager feature rows use the same row, controls, icons, action ordering, menus, overflow handling, animation and status/progress presentation as main scenarios. Periodic control/status updates patch rows without replacing the tree, moving focus, scrolling, or closing a context menu. Support creating, renaming and deleting groups, dragging files between groups and reordering files, and keyboard/context actions for moving. Search filters feature title and relative path. Opening a feature navigates to its source. Test Manager offers run, run log and JSON actions and uses the existing idle/running/passed/failed tracking machinery.

Both sidebar and fullsize Library integrate features as native library items and groups in their existing tree/model, with common search, selection, navigation, favorites and details. They do not mount a second feature panel. Empty feature groups remain visible and group/order mutations share the workspace catalog with Test Manager.

Completion in standalone and export `.feature` files includes only export scenarios, Vanessa steps and user steps. YAML nested scenarios remain available in YAML scenario completion.

## Creation

Add a New feature command alongside existing creation commands and UI menus. Default ru/en templates follow the user-supplied Vanessa templates: language header, @tree, functional title, role/want/business outcome, context opening TestClient, scenario. Ask for feature/scenario title and destination under the configured tests root. A custom template setting points to a feature file and uses documented placeholders for feature/scenario titles. Offer documented optional Gherkin sections/tags rather than inventing YAML-style fields.

## Launch configuration

Offer an adjacent same-stem JSON and a saved explicit JSON association, with a picker for other launch JSONs. Generate `<feature-stem>.json` from a selected existing parameter profile without switching the global active profile. Convert supported launch-related build parameters and merge Additional VA parameters and GlobalVars using existing override/alias rules. Always target this one feature through `КаталогФич`/`featurepath`; constrain FeaturesToRun while preserving scenario/tag filters, report settings and business variables. Reuse existing built-in launcher and its infobase choice. Use runtime copies for launch-specific edits; preserve authored JSON. Require confirmation before replacing an existing output file.

## Validation

Behavior tests cover ru/en creation, custom templates, duplicate filenames, export/compiled exclusions, persistent groups and ordering, bad/stale file associations, JSON targeting and profile merge, and Test Manager run-state integration. Run type checks, lint, full tests and extension build. Real 1C execution requires a configured local platform and infobase and will be reported separately from automated verification.

## Documentation sources

- https://github.com/Pr-Mex/vanessa-automation/blob/develop/docs/MainHelp/index.MD — feature structure, tags and Variables section.
- https://pr-mex.github.io/vanessa-automation/dev/JsonParams/JsonParamsEN/ — `featurepath`, `scenariofilter`, `FeaturesToRun`, client/runtime/report settings.
