# Change Log

# Release Notes 2.0.0

## Breaking changes

- Extension renamed to `KOT for 1C` (_**K**eep **O**n **T**esting_).
- Panel **Phase Switcher** renamed to **Test Manager**.
- Context menu items and commands now use the `KOT -` prefix ([#10](https://github.com/kakoytochelik/KOTfor1C/issues/10)).
- Commands and settings moved to the `kotTestToolkit.*` namespace.
- Removed obsolete 1C:Drive-specific features: test mail settings and `RepairTestFile`.
- New Marketplace ID: `AlexeyEremeev.kot-test-toolkit`.

_Attention: the previous plugin version (`1C:Drive Test Helper 1.11.2`) does not support direct upgrade to this version. Install the new plugin (`KOT for 1C`) and remove the old extension._

## New features

### Test Manager and **Vanessa Automation support**

- Added **Vanessa Automation** launch directly from the **Test Manager** panel (formerly Phase Switcher) ([#13](https://github.com/kakoytochelik/KOTfor1C/issues/13)):
  - Two launch modes: regular automatic run of selected tests and launch for manual work.
  - Scenario status display: running, passed, failed, stale result (for example, if a related nested scenario was changed).
  - Quick access to run log file for failed test completion.
  - Live log view while scenario execution is in progress (with configurable refresh interval).
- Added `Favorites` tab:
  - Quick open of a favorite scenario or remove it from the list.
  - Drag-and-drop favorite scenarios into the editor: inserts a nested scenario call with parameters.
  - Tests can be added to and removed from `Favorites` through the editor context menu.
  - Auto-add newly created scenarios to `Favorites` (toggle in settings).
  - Favorites list supports sorting by scenario name and scenario code.
- Added highlighting of main scenarios affected by the currently open file.
- Added ability to rename groups and scenarios through the context menu.

### Test build and Parameters Manager

- Improved scenario build process:
  - Added ability to cancel the current test build.
  - After build: quick access to feature files and results directory ([#9](https://github.com/kakoytochelik/KOTfor1C/issues/9)).
- New Parameters Manager UI with tabs:
  - SPPR build parameters (existing);
  - additional Vanessa Automation parameters (new);
  - global variables `GlobalVars` (new).
  - JSON import/export for each tab.
  - Search by parameter name on each tab.

### Editor and scenario quality

- Added scenario diagnostics with error and warning highlighting ([#14](https://github.com/kakoytochelik/KOTfor1C/issues/14)):
  - unknown steps and calls;
  - extra and missing parameters;
  - quote issues;
  - unclosed `If/Do` blocks;
  - incomplete service sections;
  - duplicate scenario codes.
- `Quick Fix` for diagnostics:
  - Replace with nearest similar step or call while preserving line arguments.
  - `Maybe you meant` block with similar step suggestions in the diagnostic description.
  - Automatic insertion of missing parameters.
- Improved hover hints and IntelliSense:
  - for steps: with actual arguments from the line;
  - for calls: with scenario description and compact summary (number of files, parameters, and nested calls) ([#12](https://github.com/kakoytochelik/KOTfor1C/issues/12)).
- Improved nested scenario call completion and insertion of default parameter values.
- Added automatic alignment of Gherkin tables and scenario call parameters on file save ([#7](https://github.com/kakoytochelik/KOTfor1C/issues/7), [#15](https://github.com/kakoytochelik/KOTfor1C/issues/15)).
- Auto-fill of `NestedScenarios` and `ScenarioParameters` blocks now runs only when there are real changes.
- Added unique name and code validation when creating scenarios.
- Added extension setting that defines language for newly created scenarios (`#language: ru/en`).
- Added extension setting that toggles visibility of functionality specific to 1C:Drive.

### Scenario metadata

- Added and supported `KOTМетаданные` block for storing service data.
- Automatic migration of legacy tags to the new format on save.
- Support for user scenario description in `KOTМетаданные.Описание` ([#12](https://github.com/kakoytochelik/KOTfor1C/issues/12)).

## Fixes and improvements

- Improved autosave stability and section refill operations ([#6](https://github.com/kakoytochelik/KOTfor1C/issues/6)).
- Improved cache update performance ([#11](https://github.com/kakoytochelik/KOTfor1C/issues/11)).
- Switching Activity Bar panels no longer removes build lock during scenario assembly ([#17](https://github.com/kakoytochelik/KOTfor1C/issues/17)).
- Improved localization, context menus, and overall UI structure.
- `.vsix` package size significantly reduced.
- Updated `codicons`.
- Settings reorganized.

---
---
---


# 1.11.2
- **New features**:
    - **Scenario Build Parameters Manager:**
        - New interface for managing `yaml_parameters.json` through a convenient key-value table.
        - Default parameters are generated based on extension settings (BuildPath, yamlSourceDirectory).
        - Secure settings storage in VS Code SecretStorage.
        - Support for loading/saving parameters from/to JSON files.
        - List of supported parameters is available [on ITS](https://its.1c.ru/db/sppr2doc#content:124:hdoc:issogl1_11.8.3).
- **Fixes**:
    - **Refresh button availability fixed:** the "Refresh" button is now always available, even when no tests are found for Phase Switcher.
    - **Hardcoded paths fixed:** replaced hardcoded `SCAN_DIR_RELATIVE_PATH` constant with `YamlSourceDirectory` setting.
    - Fixed untranslated messages and tooltips.
    - Fixed insertion of an extra line into `NestedScenarios` block.
    - Tabs are now replaced only at the beginning of a line.
    - FirstLaunch build now processes only required XML files.
    - New main scenario creation now respects `ModelBDid` setting (configured in Scenario Build Parameters Manager).
    - Tab auto-replacement and scenario header block refill, as well as step autocompletion suggestions, now work only in YAML files containing `ТипФайла: "Сценарий"` (protection for non-test YAML files).
- **Removed**:
    - **YAML Parameters Template setting:** removed in favor of Scenario Build Parameters Manager.
    - **Split Feature Files setting:** removed because it is now configured via Scenario Build Parameters Manager.
    - **СборкаТекстовСценариев parameters setting:** removed because all parameters are now managed via Scenario Build Parameters Manager.

# 1.10.6
- Fixed preserving parameter values when the value is an empty string.

# 1.10.5
- **New features**:
    - **Autofill on save:**
        - Added automatic filling of `NestedScenarios` and `ScenarioParameters` sections on YAML file save.
        - New "clear and refill" logic ensures correct item order according to scenario text.
        - Preserves user parameter values (`Значение: "Value"`) during autofill.
        - Separate settings for each function: tab replacement, nested scenarios fill, scenario parameters fill.
        - Unified progress bar and consolidated completion notifications.
        - Automatic save after processing to avoid unsaved-change state.
    - **Performance optimization:**
        - **Cache initialization on startup:** workspace scan and scenario cache build now run on extension activation, not on first panel open.
        - **Scenario UID caching:** extraction and caching of UID from `ДанныеСценария` blocks for faster access.
        - **Optimized nested scenarios fill:** cache-based lookup instead of file system search speeds up operation by 25-50x.
        - **Optimized scenario open:** instant scenario opening via cache instead of slow file search (50-100x speedup).
- **Fixes**:
    - **Unified logic:** manual commands and auto-save now use the same "clear and refill" logic.
    - **Improved parameter detection:** scenario parameters are now detected correctly (only `_`, `-`, letters and digits).

# 1.9.9
- **New features**:
    - **Configurable 1C startup parameters:**
        - Added ability to configure all 1C:Enterprise launch parameters via a single setting string.
        - Separate setting for additional `/C` parameters for `СборкаТекстовСценариев` processing. More details [here](https://its.1c.ru/db/sppr2doc#content:124:hdoc).
    - **Configurable project paths:**
        - All previously hardcoded paths can now be configured via extension settings.
        - FirstLaunch folder path setting with automatic hiding of the button when the folder does not exist.
    - **Improved build feedback:**
        - Improved build result notifications.
        - Improved Output log display.
        - "Open Error File" button for quick access to JUnit XML details.
        - Accurate error detection via JUnit XML content analysis.
- **Fixes and improvements**:
    - **Localization files optimized:** removed unused translation strings.
    - **Settings order fixed:** all settings now have consistent ordering for proper display.
    - **Obsolete functionality removed:** DriveTrade processing removed completely.

# 1.9.1
- **New features**:
    - **Multilingual support:**
        - Full extension UI localization in Russian and English.
        - `Language override` setting to choose extension language independently from VS Code language.
        - Multilingual Gherkin steps with 4-column `steps.htm` support (Russian step, Russian description, English step, English description).
        - Smart display: typing a Russian step shows Russian description and both step variants; typing an English step shows English description and both step variants.
    - **Automatic tab conversion:**
        - Tabs in YAML files are automatically replaced with spaces on save.
        - Removed manual "Replace tabs with spaces" command from context menu.
- **Fixes and improvements**:
    - Improved parsing of multiline steps from `steps.htm`.
    - Improved localized error handling.
    - All file search, parameter fill, and step refresh operations now show progress.

# 1.8.0
- **New features**:
    - **Automatic FirstLaunch archive creation:**
        - Added `Build FL` button in command palette and `Build` panel.
        - Configuration version from current branch is now set automatically in all required places.
        - Ability to save resulting archive to a custom directory and open it.
- **Fixes and improvements**:
    - `Test Build` panel renamed to `Build`, because it now builds not only tests but also FirstLaunch archive.
    - `Accounting` list renamed to `Accounting mode`.
    - Removed DriveTrade toggle as a legacy mechanism.
    - `Split Feature Files` is now disabled by default.

# 1.7.1
- **Fixes and improvements**:
    - **Settings reorganization:**
        - More accurate grouping of settings by category.
        - Removed unused settings (`DbUser`, `DbPassword`).
        - `Split Feature Files` changed from dropdown to checkbox. Default value is `True`. Added clearer setting description.
    - **Required parameters checks:**
        - Attempting to run test build without configured paths now shows a clear error and a prompt to fill settings.
        - Attempting to open MXL file without configured paths now shows a clear error and a prompt to fill settings.

# 1.7.0
- **New features**:
    - **Working with files from editor:**
        - **Open MXL file from editor:** added context menu command to find and open `.mxl` by selected name in "1C:Enterprise — file workshop" (requires separate installation).
        - **Reveal file in VS Code Explorer:** new command to find file by selected name and reveal it in sidebar.
        - **Open in system file explorer:** new command to open found file location in Windows Explorer or Finder.
    - **Build process improvements:**
        - **Progress bar:** build now shows a progress notification.
        - **Error notifications:** on failed build, shows notification with quick link to log file.
        - **Optional Output:** added setting to enable/disable automatic Output panel opening on build start.
        - **Open build results:** after successful build, you can open folder with generated `.feature` files.
    - **Scenario creation:**
        - Creating main or nested scenario now automatically creates an empty `files` folder for related files (unification).

# 1.6.2
- **New features**:
    - Since `NestedScenarios` and `ScenarioParameters` can contain many blocks, automatic collapsing of these sections on test-file open was added for better readability and navigation. Configurable in settings.

# 1.6.1
- **Fixes and improvements**:
    - Added auto-numbering for autofilled blocks in `NestedScenarios` and `ScenarioParameters` sections.
    - Improved indentation and line-break logic for autofilled blocks in `NestedScenarios` and `ScenarioParameters` sections.
    - Fixed and sped up parsing of scenarios with special characters for autofill in `NestedScenarios` and `ScenarioParameters` sections.

## 1.6.0
- **Autofill for "NestedScenarios" section:**
    - By context menu command `1C:Drive - Fill NestedScenarios section`, the section is automatically filled with missing blocks for called scenarios.
- **Autofill for "ScenarioParameters" section:**
    - By context menu command `1C:Drive - Fill ScenarioParameters section`, the section is automatically filled with missing blocks for parameters used in the scenario.
- **Replace tabs with spaces:**
    - By context menu command `1C:Drive - Replace tabs with spaces`, all tab-based indentation is replaced with 4 spaces.
- **Removed old context menu commands:** (_still available from Command Palette_)
    - `1C:Drive - Insert NestedScenarios block`
    - `1C:Drive - Insert ScenarioParameters block`

## 1.5.2
- **Improved "NestedScenarios" block insertion:**
    - Autofill from selection: if a selected line matches a scenario call, the extension now tries to find that scenario file.
    - If found, `UIDNestedScenario` and `ScenarioName` in the inserted block are automatically filled from that scenario file.
    - If file is not found or UID/Name cannot be extracted, the block is inserted with empty values as before.
- **Context menu sections**:
    - Context menu items were split into 3 categories:
        - Navigation
        - Creation
        - Editing

## 1.5.0
- **Autocompletion for nested scenario calls:**
    - While typing in `ScenarioText:`, autocompletion now suggests not only standard Gherkin steps, **but also calls to all discovered scenarios**.
    - If selected scenario has parameters, it is inserted as a multiline snippet with scenario name and parameter lines with placeholders.
    - Scenario and parameter completion data is refreshed when clicking "Refresh" in "KOT for 1C" panel (together with Phase Switcher data refresh).

- **External loading of Gherkin step definitions:**
    - Added ability to load `steps.htm` (used for autocomplete and hovers) from external URL, allowing step updates without extension update.
    - Settings now allow specifying external `steps.htm` URL (default points to repository file). If empty, only bundled local copy is used.
    - Implemented caching: downloaded file is stored locally and reused for 24 hours or until URL changes.
    - Added command palette command `1C:Drive - Refresh step library` to force download and cache update.
    - If external source is unavailable, extension falls back to valid cache or bundled local `steps.htm` to keep functionality available.

- **Scenario creation buttons:**
    - Added buttons to create Main and Nested scenarios in Phase Switcher panel.

- **Fixed:**
    - When creating a new Main scenario, Phase Switcher test list now refreshes automatically.



## 1.4.1
- Added Collapse/Expand all phases button.
- Added indicator for unapplied changes inside a phase.
- Updated button styles.

## 1.4.0

- **TypeScript integration of test build**:
    - Completely migrated `BuildYAML.bat` logic into extension code (`phaseSwitcher.ts`).
    - Test build process is now managed directly by the extension using VS Code API and Node.js for file operations and 1C process launch.
    - [BETA] Test build is now available on macOS.
- **"Phase Switcher" UI improvements**:
    - Replaced phase dropdown with expandable Tree View groups.
    - Added enabled-tests counter to phase group headers.
    - Added per-phase toggle buttons in each group header for switching tests inside that phase. _(Removed global "Switch phase" button.)_
- **Fixes**:
    - [Refresh button remains active during test build](https://github.com/kakoytochelik/KOTfor1C/issues/2)
    - [Test build does not start when empty infobase path contains spaces](https://github.com/kakoytochelik/KOTfor1C/issues/1)

## 1.3.3

- Integrated test build functionality into extension panel with variable replacement in tests.
- Added extension settings.
- Added button icons.
- Fixed styles and rendering of several UI elements.

## 1.2.0

- Implemented Gherkin step autocompletion based on Vanessa Automation step library.
- Added hover hints for Gherkin steps that show step descriptions from Vanessa Automation step library when hovering a step line in YAML files.

## 1.1.1

- Added ability to navigate to parent scenarios from Phase Switcher.
- Insertion of `NestedScenarios` and `ScenarioParameters` blocks now automatically targets corresponding sections instead of current cursor position.
- Improved display of long scenario names in Phase Switcher.

## 1.0.0

- Initial release.
