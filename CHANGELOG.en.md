# Change Log

# 1.9.9
- **New Features**:
    - **Configurable 1C Startup Parameters:**
        - Added ability to configure all 1C:Enterprise startup parameters through a single settings string.
        - Separate setting for additional `/C` parameters for BuildScenarioBDD (СборкаТекстовСценариев) processing. Read more about parameters [here](https://its.1c.ru/db/sppr2doc#content:124:hdoc) (Russian).
    - **Configurable Project Paths:**
        - All previously hardcoded paths can now be configured through extension settings.
        - Optional EPF files (`RepairTestFile.epf`) - processing is skipped if path is not set.
        - FirstLaunch folder path setting with automatic button hiding if folder doesn't exist.
    - **Enhanced Build Feedback:**
        - Improved build result notifications.
        - Improved Output log display.
        - "Open Error File" button for quick access to JUnit XML file with details.
        - Accurate error detection through JUnit XML file content analysis.
- **Fixes and Improvements**:
    - **Optimized Localization Files:** Removed unused translation strings.
    - **Fixed Settings Numbering:** All settings now have sequential order numbers for correct display.
    - **Removed Legacy Functionality:** Completely removed DriveTrade processing.

# 1.9.1
- **New Features**:
    - **Multilingual Support:**
        - Complete localization of the extension interface in Russian and English.
        - `Language override` setting to choose extension language independently of VS Code language.
        - Multilingual Gherkin steps with support for 4-column structure in `steps.htm` (Russian step, Russian description, English step, English description).
        - Smart display: When entering a Russian step, shows Russian description and both step variants; when entering English, shows English description and both variants.
    - **Automatic Tab Conversion:**
        - When saving YAML files, tabs are automatically replaced with spaces.
        - Removed manual "Replace tabs with spaces" command from context menu.
- **Fixes and Improvements:**
    - Improved parsing of multi-line steps from `steps.htm`.
    - Improved error handling with localized messages.
    - All file search operations, parameter filling, and step updates now show execution progress.

# 1.8.0
- **New Features**:
    - **Automatic FirstLaunch Archive Creation:**
        - Added FirstLaunch archive creation button `Build FL` to command palette and `Build` panel.
        - Automatically sets configuration version from current branch in all required places.
        - Ability to save the final archive to a user directory and open that directory.
- **Fixes and Improvements:**
    - `Test Build` panel renamed to simply `Build`, as it now builds not only tests but also FirstLaunch archive.
    - `Accounting` list renamed to `Accounting mode`.
    - Removed DriveTrade toggle as it's legacy mechanics.
    - `Split Feature Files` parameter is now disabled by default.

# 1.7.1
- **Fixes and Improvements:**
    - **Settings Reorganization:**
        - More accurate placement of settings by categories.
        - Removed unused settings (`DbUser`, `DbPassword`).
        - Instead of dropdown, `Split Feature Files` is now a checkbox. Default value `True`. Added more accurate setting description.
    - **Parameter Completeness Check:**
        - When trying to run test build without paths set in settings, there will be a clear error and suggestion to fill settings.
        - When trying to open MXL file without paths set in settings, there will be a clear error and suggestion to fill settings.

# 1.7.0
- **New Features**:
    - **Working with files from editor:**
        - **Open MXL file in editor:** Added command to context menu for finding and opening `.mxl` file by selected name in "1C:Enterprise — work with files" program (requires separate installation).
        - **Show file in VS Code explorer:** New command for finding file by selected name and displaying it in VS Code sidebar.
        - **Open in system explorer:** New command for opening found file location in Windows Explorer or Finder.
    - **Build process improvements:**
        - **Progress bar:** During test build, a notification with progress bar is now displayed.
        - **Error notifications:** In case of unsuccessful build, a notification appears with a button for quick navigation to log file.
        - **Optional Output:** Added setting to enable/disable automatic opening of Output panel when starting build.
        - **Opening build results**: After successful test build, you can open directory with collected `.feature` files.
    - **Scenario creation:**
        - When creating main or nested scenario, an empty files folder is now automatically created for accompanying files (unification).

# 1.6.2
- **New Features**:
    - Since `NestedScenarios` and `ScenarioParameters` sections can contain many blocks, for improved navigation convenience and readability, automatic collapsing of these sections when opening test file has been added. Toggleable in settings.

# 1.6.1
- **Fixes and Improvements:**
    - Added auto-numbering for auto-filled blocks in `NestedScenarios` and `ScenarioParameters` sections.
    - Improved indentation and line break logic for auto-filled blocks in `NestedScenarios` and `ScenarioParameters` sections.
    - Fixed and accelerated parsing of scenarios with special characters for auto-filling blocks in `NestedScenarios` and `ScenarioParameters` sections.

## 1.6.0
- **Auto-fill "NestedScenarios" section:**
    - By context menu command `1C:Drive - Fill NestedScenarios section`, the section is automatically filled with missing blocks for called scenarios.
- **Auto-fill "ScenarioParameters" section:**
    - By context menu command `1C:Drive - Fill ScenarioParameters section`, the section is automatically filled with missing blocks for parameters used in the scenario.
- **Replace tabs with spaces:**
    - By context menu command `1C:Drive - Replace tabs with spaces`, all tab indentation is replaced with 4 spaces.
- **Removed old commands from context menu:** (_they are still available from palette_)
    - `1C:Drive - Insert NestedScenarios block`
    - `1C:Drive - Insert ScenarioParameters block`

## 1.5.2
- **Improved "NestedScenarios" block insertion:**
    - Auto-fill from selection: If a line corresponding to scenario call is selected when calling the command, the extension will now try to find the file of this scenario.
    - In case of success, `UIDNestedScenario` and `ScenarioName` fields in the inserted block will be automatically filled with `UID` and `Name` values from the found scenario file.
    - If the scenario file is not found, or UID/Name could not be extracted from it, the block will be inserted with empty values, as before.
- **Context menu sections**:
    - Context menu items are divided into 3 categories:
        - Navigation
        - Creation
        - Editing

## 1.5.0
- **Autocompletion for nested scenario calls:**
    - When entering text in `ScenarioText:` block, autocompletion options are suggested not only for standard Gherkin steps, **but also for calls to all found scenarios**.
    - If the selected scenario for insertion contains parameters, it is inserted as a multi-line snippet, including scenario name and lines for each parameter with placeholders for their values. 
    - The list of scenarios and their parameters for autocompletion is updated when pressing the "Refresh" button on the "1C:Drive Test Helper" panel (together with updating data for Phase Switcher).

- **External loading of Gherkin step definitions:**
    - Added ability to load `steps.htm` file (used for autocompletion and hints) from external URL. This allows updating step definitions without updating the entire extension.
    - In extension settings, user can specify URL for `steps.htm` file (default link to file in repository is set). If left empty, only local copy from extension will be used.
    - Caching mechanism implemented: loaded file is saved locally and used for 24 hours or until next URL change.
    - Added new command to command palette: `1C:Drive - Refresh step library`. This command forcibly loads `steps.htm` from specified URL and updates cache.
    - In case of external resource unavailability or loading error, extension will use data from cache (if valid) or, as last resort, local copy of `steps.htm` included in extension, to ensure continuous operation.

- **Scenario creation buttons:**
    - Added buttons for creating Main or Nested scenarios to Phase Switcher panel.

- **Fixed:**
    - When creating new Main scenario, test list in Phase Switcher now automatically updates.

## 1.4.1
