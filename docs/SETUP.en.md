# KOT for 1C — Technical Setup (EN)

<p align="center">
  <a href="../README.en.md">← Back to README</a> | <a href="./SETUP.ru.md">Русская версия</a>
</p>

Detailed technical reference for extension setup.

## 1) What This Document Covers

This file describes system paths, build parameters, diagnostics, commands, and limitations.

## 2) ITS References

- `BuildScenarioBDD` / `СборкаТекстовСценариев.epf` data processor from SPPR and build parameters:
  - [ITS: SPPR scenario build documentation](https://its.1c.ru/db/sppr2doc#content:124:hdoc) (in Russian)

## 3) Minimal Setup

| Setting | What to set | Why | Required |
|---|---|---|---|
| `kotTestToolkit.paths.yamlSourceDirectory` | Path to source YAML scenarios inside repo | Source for cache, navigation, diagnostics | Yes |
| `kotTestToolkit.paths.oneCEnterpriseExe` | Full path to `1cv8.exe` (Windows) or `1cestart` (macOS) | Runs 1C processes during build | For build |
| `kotTestToolkit.paths.buildScenarioBddEpf` | Path to `BuildScenarioBDD.epf` / `СборкаТекстовСценариев.epf` | Converts YAML into `.feature` | For build |
| `kotTestToolkit.assembleScript.buildPath` | Output folder for generated `.feature` files | Build target location | For build |
| `kotTestToolkit.paths.emptyInfobase` | Path to empty file infobase | Runtime base for build processor | For build |

## 4) System Paths: What and Why

| Setting | What to set | Used by | Required | Notes |
|---|---|---|---|---|
| `kotTestToolkit.paths.emptyInfobase` | Empty file infobase directory | Test build | For build | Usually absolute path |
| `kotTestToolkit.assembleScript.buildPath` | Build output directory | Test build | For build | Usually absolute path |
| `kotTestToolkit.paths.oneCEnterpriseExe` | 1C executable path | Build process launch | For build | `1cv8.exe` or `1cestart` |
| `kotTestToolkit.paths.fileWorkshopExe` | `1cv8fv.exe` path | MXL open command | No | Required only for MXL operations |
| `kotTestToolkit.paths.buildScenarioBddEpf` | Path to `BuildScenarioBDD.epf` / `СборкаТекстовСценариев.epf` | `.feature` build | For build | Repo-relative |
| `kotTestToolkit.paths.yamlSourceDirectory` | YAML scenario source folder | Scenario cache, diagnostics, completion | Yes | Keep this scope narrow for better performance |
| `kotTestToolkit.paths.disabledTestsDirectory` | Disabled tests folder | Phase Switcher `Apply` operations | For Phase Switcher | Usually mirrors source folder structure |
| `kotTestToolkit.paths.firstLaunchFolder` | FirstLaunch data folder | FirstLaunch archive action | No | **1C:Drive scenario (regional versions)** |

## 5) Other Settings

### Editor and diagnostics

| Setting | Purpose |
|---|---|
| `kotTestToolkit.localization.languageOverride` | Extension UI language |
| `kotTestToolkit.steps.externalUrl` | External `steps.htm` source |
| `kotTestToolkit.editor.autoCollapseOnOpen` | Collapse sections `ПараметрыСценария` and `ВложенныеСценарии` on open |
| `kotTestToolkit.editor.autoReplaceTabsWithSpacesOnSave` | Replace tabs with spaces on save |
| `kotTestToolkit.editor.autoAlignNestedScenarioParametersOnSave` | Align nested-call parameters by `=` |
| `kotTestToolkit.editor.autoAlignGherkinTablesOnSave` | Align Gherkin tables |
| `kotTestToolkit.editor.autoFillNestedScenariosOnSave` | Auto-fill `NestedScenarios` |
| `kotTestToolkit.editor.autoFillScenarioParametersOnSave` | Auto-fill `ScenarioParameters` |
| `kotTestToolkit.editor.scenarioParameterExclusions` | Exclusions for `[]` values, against wrong parameters detection |
| `kotTestToolkit.editor.showRefillMessages` | Show/hide refill notifications |
| `kotTestToolkit.editor.checkRelatedParentScenarios` | Validate errors in related parent scenarios |

### Build runtime

| Setting | Purpose |
|---|---|
| `kotTestToolkit.assembleScript.showOutputPanel` | Auto-open `Output` when build starts |
| `kotTestToolkit.startupParams.parameters` | 1C process startup parameters |

## 6) Commands (ID + human-readable title)

Most commands are available in Command Palette; some are also in editor/explorer context menus.

### Navigation and scenario creation

| Command ID | UI title | Purpose |
|---|---|---|
| `kotTestToolkit.openSubscenario` | `KOT - Open scenario` | Opens called scenario from a call line |
| `kotTestToolkit.findCurrentFileReferences` | `KOT - Find references to current scenario` | Finds all usages of current scenario |
| `kotTestToolkit.createNestedScenario` | `KOT - Create nested scenario` | Creates nested scenario from template |
| `kotTestToolkit.createMainScenario` | `KOT - Create main scenario` | Creates main scenario from template |

### Diagnostics, blocks, formatting

| Command ID | UI title | Purpose |
|---|---|---|
| `kotTestToolkit.fixScenarioIssues` | `KOT - Fix scenario issues` | Applies grouped formatting fixes |
| `kotTestToolkit.checkAndFillNestedScenarios` | `KOT - Fill NestedScenarios section` | Refills `NestedScenarios` block |
| `kotTestToolkit.checkAndFillScriptParameters` | `KOT - Fill ScenarioParameters section` | Refills `ScenarioParameters` block |
| `kotTestToolkit.replaceTabsWithSpacesYaml` | `KOT - Replace tabs with spaces` | Normalizes tabs in YAML |
| `kotTestToolkit.addScenarioParameterExclusion` | `KOT - Add scenario parameter exclusion` | Adds selected text to parameter exclusions |
| `kotTestToolkit.scanWorkspaceDiagnostics` | `KOT - Scan workspace diagnostics` | Full workspace diagnostics scan (heavy) |
| `kotTestToolkit.refreshGherkinSteps` | `KOT - Refresh steps library` | Reloads step library |
| `kotTestToolkit.insertUid` | `KOT - Insert new UID` | Inserts a new UUID |

### File operations

| Command ID | UI title | Purpose |
|---|---|---|
| `kotTestToolkit.openMxlFile` | `KOT - Open MXL file in editor` | Finds selected MXL name and opens via File Workshop |
| `kotTestToolkit.openMxlFileFromExplorer` | `KOT - Open MXL file in editor` | Opens MXL from Explorer panel context menu |
| `kotTestToolkit.revealFileInExplorer` | `KOT - Reveal file in VS Code Explorer` | Finds and highlights file in Explorer panel |
| `kotTestToolkit.revealFileInOS` | `KOT - Reveal file in OS file manager` | Opens file location in OS explorer |

### Build

| Command ID | UI title | Purpose |
|---|---|---|
| `kotTestToolkit.openYamlParametersManager` | `KOT - Open Build Scenario Parameters Manager` | Opens `yaml_parameters.json` manager UI |
| `kotTestToolkit.createFirstLaunchZip` | `KOT - Create FirstLaunch archive` | Builds FirstLaunch archive (typically 1C:Drive flow) |
| `kotTestToolkit.openBuildFolder` | `KOT - Open build folder` | Opens build output folder |

## 7) Keyboard Shortcuts

Default shortcuts exist, but it is recommended to assign/rebind them in VS Code for your team:

- `Preferences: Open Keyboard Shortcuts`
- `Preferences: Open Keyboard Shortcuts (JSON)`

## 8) Performance

- Use local diagnostics for day-to-day work.
- Run `scanWorkspaceDiagnostics` manually only when needed.

## 9) Limitations

- macOS: MXL opening is typically unavailable.
- Linux: support is partially tested.
