# 1C:Drive Test Helper
<p align="center">
  <img src="./docs/1CDriveTestHelper_poster.png" alt="1C:Drive Test Helper Icon" width="600"/><br>
  <a href="CHANGELOG.en.md"><img src="https://img.shields.io/badge/version-1.11.0-yellow"></a>
</p>

<p align="center">
  <a href="README.md">🇷🇺 Русский</a> | <a href="README.en.md">🇺🇸 English</a>
</p>

Helper for developing and managing 1C regression tests in VS Code. Speeds up navigation between scenarios, creating new scenarios from templates, and managing phases and builds for test runs.

**Universal Solution:** While initially designed for testing the 1C:Drive configuration, this extension is compatible with any other 1C testing projects that use YAML-based scenario files and use Vanessa Automation. It works with projects built using the [SPPR (СППР)](https://its.1c.ru/db/sppr2doc#content:124:hdoc) and can be used for other 1C projects.

# Features

## Working with scenario text:
* **Autocompletion and hints:** 
    * Suggests scenario call steps from the project folder, including their parameters (IntelliSense).
    * Suggests Gherkin steps from Vanessa Automation as you type (IntelliSense). Supports multiple translations.
    * Shows step description from the Gherkin step library for Vanessa Automation when hovering over a step line in a YAML file. Shows description in the language of entered text and variant of this step in other language.
    * To ensure the relevance of autocompletion and hints for Gherkin steps for Vanessa Automation, the extension supports loading the `steps.htm` file from an external resource.

* **Quick navigation:**
    * **Open scenario:** When on a line like `And ScenarioName`, you can quickly open the corresponding `.yaml` file where `Name: "ScenarioName"` is defined.
    * **Find current scenario calls:** From the current scenario file (`scen.yaml`), you can quickly see a list of all places (`And Name...`) where this scenario is used.

* **File operations:**
    * **Open MXL file in editor:** From the context menu on a **selected** filename, you can find and open it in "1C:Enterprise — work with files".
    * **Show file in VS Code explorer:** Quickly finds a file by **selected** name and highlights it in the VS Code sidebar. Works with both nested files and scenario files.
    * **Show file in system explorer:** Finds a file by **selected** name and opens its location in the system explorer (Windows Explorer, Finder). Works with both nested files and scenario files.
    * *For all search commands, a two-level search is used: first in the `files` folder next to the current and nested scenarios, then throughout the `tests` directory.*

* **Creating scenarios from templates:**
    * **Create nested scenario:**
        * Called from context menu or command palette (`1C:Drive - Create nested scenario`) or from the Phase Switcher panel.
        * Requests Name (can be pre-filled if the command is called from a pre-written call line `And ...`), Test numeric code, and Parent folder.
        * Automatically creates structure: 
            * `<Parent folder>/<Code>/scen.yaml`
            * `<Parent folder>/<Code>/files/`
    * **Create main scenario:**
        * Called from context menu or command palette (`1C:Drive - Create main scenario`) or from the Phase Switcher panel.
        * Requests Main scenario name, **metadata for Phase Switcher** (Phase/tab name, Sort order, Default state) and Parent folder.
        * Automatically creates structure:
            * `<Parent folder>/<Name>/scen.yaml`
            * `<Parent folder>/<Name>/test/<Name>.yaml`
            * `<Parent folder>/<Name>/files/`

* **Code insertion (Snippets):**
    * **Fill NestedScenarios section:** Refills the `NestedScenarios` (`ВложенныеСценарии`) section with all scenario calls found in the scenario text with corresponding `Name` and `UID`. Supports correct order according to call sequence.
    * **Fill ScenarioParameters section:** Refills the `ScenarioParameters` (`ПараметрыСценария`) section with all parameters found in the scenario text. Preserves custom parameter values during refill.
    * **Auto-fill on Save:** Automatic execution of section filling operations when saving YAML files (switchable in Settings):
        * **Replace tabs with spaces**
        * **Auto-fill NestedScenarios**
        * **Auto-fill ScenarioParameters**
    * **Insert new UID:** Generates and inserts a new UUID v4 at the current cursor position.


## 1C:Drive Test Helper Panel:
To open, click on the extension icon <img src="./docs/activity_icon_mini.png" height="20" alt="Icon" style="vertical-align: bottom;"> in the sidebar (Activity Bar).

### Phase Switcher Panel:

Successor of the [Phase Switcher](https://github.com/kakoytochelik/PhaseSwitcher) application inside the VS Code extension.

The main difference is that there's no longer a need for external configuration files, everything happens automatically!
  * **Purpose:** Allows you to quickly enable and disable test sets for different runs.
  * **Test detection:** The extension scans the tests folder (folder can be set in the settings).
  * **Test metadata:** To display a test in Phase Switcher, the `scen.yaml` file must contain a line `Name: "Test name"` and special comment markers:
      ```yaml
      # PhaseSwitcher_Tab:            # Required - Tab name in UI/test phase
      # PhaseSwitcher_Default:        # Optional - Whether the test is enabled by default (true/false)
      # PhaseSwitcher_OrderOnTab:     # Optional - Order within the phase
      ```
  * **Interface:**
      * Tests are grouped by phases in a **tree view (Tree-View)**. Each phase is an expandable group.
      * The header of each test group displays the **enabled test counter** in that phase.
      * Checkboxes show the current test state (enabled/disabled/not found).
      * **Bold font** in the test name indicates that its state has been changed but not yet applied.
      * Control buttons:
          * `Settings`: Open extension settings.
          * `Create scenario`: Dropdown menu for creating new Main or Nested scenarios.
          * `Refresh`: Rescan files and check state on disk, and update the scenario list for line autocompletion.
          * `Collapse/Expand all phases`: Toggles the expansion of **all** phases.
          * `Toggle all`: Toggle the state of **all** active tests in **all** phases.
          * `Toggle phase`: Allows you to toggle tests within a specific phase. Located to the right of the enabled test counter. 
          * `Defaults`: Reset the state of **all** tests according to their `# PhaseSwitcher_Default:` marker.
          * `Apply`: Physically moves the parametric folders for the selected tests between directories (to support older versions of build processing; later, the list of tests will be passed as a parameter for processing).
      * Click the pencil button to open the scenario in the editor.
      * **Status bar:** Displays current status (loading, presence of changes, application result).

### Build Panel:
#### FirstLaunch archive build:
  * Allows you to build a FirstLaunch.zip archive for testing regional versions.
  * `Build FL`: builds the archive, substitutes the current configuration version from the branch into the files.
  * After successfully building the archive, it offers to choose a location for saving, after which you can open the directory with the saved file from the notification.

#### Test build:
  * Allows you to run the scenario build processing (BuildScenarioBDD/СборкаТекстовСценариев) with configured parameters.
  * **Process indication:** During the build, a progress bar is displayed as a notification.
  * **Error notifications:** In case of unsuccessful build, a notification appears with a button for quick navigation to the log file.
  * In the extension settings, you can specify test email parameters and disable automatic opening of the `Output` panel when starting the build.
  * If specified in the settings, automatically removes "unnecessary" steps from certain tests (001_Company, I_start_my_first_launch)
  * Build management:
      * Via settings button you can open the Build Scenario Parameters Manager.
      * `Accounting mode` dropdown: you can select the accounting type before building tests.
      * `Build tests`: runs the build script.
  * Separate status bar for the build process.
  * After successful build, you can open the directory with the built tests.

#### Build Scenario Parameters Manager:
  * **Build parameter management:** Allows configuring parameters for the `yaml_parameters.json` file through a convenient interface.
  * **Parameter table:** Displays parameters in a key-value table with the ability to add, delete, and edit. [More details about possible parameters on ITS](https://its.1c.ru/db/sppr2doc#content:124:hdoc) (in Russian).
  * **Default parameters:** Generated based on extension settings (BuildPath, yamlSourceDirectory).
  * **Secure storage:** Parameters are saved in VS Code SecretStorage and restored on next opening.
  * **Automatic generation:** During test build, the `yaml_parameters.json` file is automatically created from saved parameters.
  * **Access:** Button in Assembly panel, command palette, and extension settings.

## Requirements

* Visual Studio Code;
* Project opened in the repository root folder;
* For opening MXL files from scenario text: installed [1C:Enterprise — File Workshop](https://v8.1c.ru/static/1s-predpriyatie-rabota-s-faylami/);
* For building scenarios: BuildScenarioBDD/СборкаТекстовСценариев data processor from SPPR (СППР) ([more details](https://its.1c.ru/db/sppr2doc#content:124:hdoc) in Russian), filled paths and parameters in extension settings.

## Compatibility

* **SPPR Methodology:** Compatible with projects using the SPPR (СППР) methodology for 1C test automation. Works with any projects following YAML-based scenario structure and applicable to any 1C project.
* **Cross-Platform:** Supports Windows, macOS, and Linux (Linux compatibility not fully tested).

## Setup and usage

1.  **Installation:**
    * Install from [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=AlexeyEremeev.1c-drive-test-helper)
    * Or Extensions View -> "..." -> "Install from VSIX..." -> Select the downloaded/built `.vsix` file.
    * **Important:** After updating the extension, it's recommended to restart VS Code for all features to work correctly.
2.  **Configuration:**<br>
    You can access the extension settings through the standard method via general settings or **via the settings button from the Activity Bar panel**.
    * `Language override`: sets the extension's interface language independently of VS Code's language (system/en/ru). Does not affect the display language of settings page and context menus (they are displayed in the VS Code interface language).
    * `Gherkin steps URL`: URL for loading the `steps.htm` file. Leave empty to use the file from the extension, or specify your own for dynamic updates.
    * `Auto collapse on open`: Automatically collapse `NestedScenarios` (`ВложенныеСценарии`) and `ScenarioParameters` (`ПараметрыСценария`) sections when opening a file.
    * **Auto-fill on Save settings**:
      * `Auto Replace Tabs with Spaces on Save`: Automatically replace tabs with spaces when saving YAML files (enabled by default).
      * `Auto Fill Nested Scenarios on Save`: Automatically fill NestedScenarios section when saving YAML files (enabled by default).
      * `Auto Fill Scenario Parameters on Save`: Automatically fill ScenarioParameters section when saving YAML files (enabled by default).
    * **Test email settings**:
      * `Email Address`: email address used in tests
      * `Email Password`: password for the email used in tests. For security purposes, it is set separately through a command, saved in VS Code's secure storage (`SecretStorage`). Can be removed from storage with a separate command.
      * `Email Incoming Server`: Incoming mail server (EMailTestIncomingMailServer).
      * `Email Incoming Port`: Incoming mail port (EMailTestIncomingMailPort).
      * `Email Outgoing Server`: Outgoing mail server (EMailTestOutgoingMailServer).
      * `Email Outgoing Port`: Outgoing mail port (EMailTestOutgoingMailPort).
      * `Email Protocol`: Mail protocol, IMAP or POP3 (EMailTestProtocol).
    * **Build settings**:
      * `Show Output Panel`: Show Output panel when building tests (disabled by default).
      * `Open Build Scenario Parameters Manager`: Button to open the Build Scenario Parameters Manager panel for configuring test parameters.
    * **Startup parameter settings**:
      * `Startup Parameters`: 1C:Enterprise startup parameters when running scenario build (default `/L ru /DisableStartupMessages /DisableStartupDialogs`). Any startup flags can be configured.
    * **System path settings**:
      * `Empty Infobase`: Path to the empty file infobase directory on which the scenario build processing will be launched.
      * `Build Path`: Path to the folder for built tests.
      * `1C Enterprise Exe`: Full path to the 1cv8.exe executable (Windows) or 1cestart (macOS).
      * `File Workshop Exe`: Full path to '1C:Enterprise — File Workshop' (1cv8fv.exe).
      * `BuildScenarioBDD EPF`: Path to BuildScenarioBDD.epf (СборкаТекстовСценариев.epf) processing within the project (default `build/BuildScenarioBDD.epf`).
      * `RepairTestFile EPF`: Path to RepairTestFile.epf processing within the project (default `build/RepairTestFile.epf`, optional).
      * `YAML Source Directory`: Path to folder within the project with source YAML files (default `tests/RegressionTests/yaml`).
      * `Disabled Tests Directory`: Path to folder within the project for disabled tests (default `RegressionTests_Disabled/Yaml/Drive`).
      * `FirstLaunch Folder`: Path to FirstLaunch folder within the project for creating first launch file (default `first_launch`).

3.  **Commands:**
    * Most commands are available through the **context menu** (right-click in editor) or **command palette** (`Ctrl+Shift+P` or `Command+Shift+P`, start typing `1C:Drive`).
    * For navigation and insertion, **hotkeys** can be used (check or configure them in Keyboard Shortcuts).
4.  **Phase Switcher:**
    * Open via the **icon <img src="./docs/activity_icon_mini.png" height="20" alt="Icon" style="vertical-align: bottom;"> in Activity Bar**.
    * Select the desired phase from the dropdown list.
    * Check/uncheck tests. Names of changed tests will become bold.
    * Click `Apply`.
    * Use `Refresh` if you manually changed the test folder structure.
5.  **Build Scenario Parameters Manager:**
    * Click `Build Scenario Parameters` button to open the parameters management panel
    * Configure test parameters in the table interface. List of possbile parameters and their descriptions can be found [here](https://its.1c.ru/db/sppr2doc#content:124:hdoc) (in Russian).
    * Save parameters or create backup yaml_parameters.json file
6.  **Build:**
    * Open via the **icon <img src="./docs/activity_icon_mini.png" height="20" alt="Icon" style="vertical-align: bottom;"> in Activity Bar**.
    * FirstLaunch archive build:
      * Click `Build FL`
      * Choose a location for saving
    * Test build:
      * Select accounting mode `Accounting mode`
      * Click `Build tests`

## Screenshots

### Main Interface

<div align="center">
  <p><em>Phase Switcher panel in Activity Bar</em></p>
  <img src="./docs/ActivityBar_en.png" alt="Panel in Activity Bar" width="600" style="max-width: 100%; height: auto; border-radius: 8px;"/>
</div>

### Build Scenario Parameters Manager

<div align="center">
  <p><em>Build Scenario Parameters Manager interface</em></p>
  <img src="./docs/parametersManager_en.png" alt="Build Scenario Parameters Manager" width="800" style="max-width: 100%; height: auto; border-radius: 8px;"/>
</div>

### Context Menu and Commands

<div align="center">
  <p><em>Available commands in context menu</em></p>
  <img src="./docs/commands_en.png" alt="Command list" width="600" style="max-width: 100%; height: auto; border-radius: 8px;"/>
</div>

### Autocompletion and Hover Features

<div align="center">
  <p><em>IntelliSense line autocompletion</em></p>
  <img src="./docs/autocomplete.gif" alt="Line autocompletion" width="500" style="max-width: 100%; height: auto; border-radius: 8px;"/>
  <br><br><br>
</div>

<div align="center">
  <p><em>Step description hover window</em></p>
  <img src="./docs/hover.png" alt="Step description" width="600" style="max-width: 100%; height: auto; border-radius: 8px;"/>
</div>

## TODO

* Launch built autotests in Vanessa Automation in one click.

## Known issues

* Building tests on macOS takes much longer than on Windows. Also, due to the peculiarities of the 1C platform on macOS, tracking the build execution status occurs by tracking the creation of the result file, not by the completion of the 1C process.
* Open MXL in editor feature is unavailable on macOS.
* Work on Linux has not been tested.
