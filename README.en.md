# KOT for 1C
<p align="center">
  <img src="https://raw.githubusercontent.com/kakoytochelik/KOTfor1C/main/docs/KOTfor1C_poster.png" alt="KOT for 1C banner" width="640"/><br>
  <a href="https://marketplace.visualstudio.com/items?itemName=AlexeyEremeev.kot-test-toolkit"><img src="https://img.shields.io/badge/VS%20Code-Marketplace-007ACC" alt="VS Code Marketplace"></a>
  <a href="CHANGELOG.en.md"><img src="https://img.shields.io/badge/version-2.0.0-yellow" alt="Version"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="License"></a>
</p>

<p align="center">
  <a href="README.md">🇷🇺 Русский</a> | <a href="README.en.md">🇺🇸 English</a>
</p>

KOT (Keep On Testing) is a VS Code extension for developing and maintaining 1C automated tests in YAML format (SPPR / Vanessa Automation ecosystem).

It was originally created for 1C:Drive, but in its current form it is applicable to any 1C project with a compatible scenario structure.

## Disclaimer

This project is not an official 1C product and is not affiliated with 1C.  
References to 1C and related products are used only to describe compatibility and target use.

## Format and Status

- Scenario format: YAML structure from the SPPR/Vanessa Automation ecosystem.
- The extension is production-usable and used in real projects.
- Advanced SPPR-style test classification and test set management features are still partially implemented.
- Main UI commands use the `KOT -` prefix.

## User workflow and value

Typical user workflow:

1. The user opens a new or existing 1C test project in VS Code with SPPR-style YAML scenarios.
2. The user configures required extension paths (minimum for build), if not configured yet.
3. The user edits existing scenarios and creates new ones:
   - main scenarios (feature-level);
   - nested scenarios called from other scenarios.
4. Nested-scenario parameters can be defined when needed (optional), so the same scenario can be reused multiple times in sequence or in different places with different values (for example, document number, partner, etc.).
5. Tests are organized into groups in Test Manager:
   - typically, one group groups either a sequential chain of main scenarios or scenarios from one functional category (for example, smoke, regression, accounting area, etc.);
   - each group can contain multiple main scenarios enabled/disabled by checkbox;
   - main scenarios are future feature files.
6. If needed, the user configures build parameters through the manager (supported parameters are listed on [ITS](https://its.1c.ru/db/sppr2doc#content:124:hdoc)). These parameters affect both build process and output files (`.feature`, `.json`).
7. The user starts build: enabled main scenarios are converted into `.feature` files, and `.json` files are created for Vanessa Automation settings for a specific run.
8. After build, the extension shows a notification with actions to open the file, files, or output folder.
9. If needed, the user runs scenarios from Test Manager: via the top Vanessa run button (mode + scenario picker) or via the run icon near a specific scenario for a quick standard run.

Why this is useful:

- simplifies version control: git changes are made in small YAML blocks instead of large monolithic `.feature` files, which reduces merge conflicts;
- lowers call/parameter mistakes in nested scenarios;
- speeds up authoring with IntelliSense, diagnostics, and quick fixes;
- reduces manual maintenance work for large test suites;
- provides centralized run-scope control via groups;
- makes build results more predictable and reproducible across the team;
- does not require SPPR to work with tests.

## Features

### YAML Scenario Editor

- IntelliSense for Gherkin steps (based on Vanessa Automation steps library exported to `steps.htm`).
- IntelliSense for nested scenario calls and their parameters.
- Hover hints with step descriptions.
- Hover for nested scenario calls: description, attached files count, parameter count, and nested-calls count.
- Support for steps and parameters in single/double quotes, and bracket-style parameters without quotes (`[Parameter]`).
- Highlighting for text inside `KOTМетаданные -> Описание`.

### Diagnostics and quick fix

- Checks for:
  - unclosed `If...EndIf`, `Do...EndDo` blocks;
  - unclosed quotes;
  - unknown steps and unknown nested scenario calls;
  - duplicate `ДанныеСценария.Код` values across scenarios;
  - extra/missing call parameters;
  - incomplete `NestedScenarios` and `ScenarioParameters` sections.
- `Maybe you meant` suggestions for unknown steps and calls.
- More readable multiline diagnostics for call-parameter issues.
- Quick fixes:
  - replace a line with a suggested variant;
  - add missing call parameters (with default values);

### Navigation and file operations

- Open called scenario directly from `And ...` line.
- Find all references to the current scenario.
- By selected text:
  - open MXL in `1C:Enterprise — File Workshop`;
  - reveal file in VS Code Explorer;
  - reveal file in OS file manager.

### Auto-format and auto-fill on save

Optional (configurable in settings):

- replace tabs with spaces;
- align nested-call parameters by `=`;
- align Gherkin tables;
- auto-fill `NestedScenarios` and `ScenarioParameters` sections;
- refill sections only when related data changed (calls/parameters) or when a section is incomplete.

### Scenario creation

- Create nested scenario from template.
- Create main scenario from template (with metadata for Test Manager).

### Extension panel (Activity Bar)

#### Test Manager

- Manage test sets by groups.
- Group by tabs/groups and show active test counters.
- Toggle tests per group or in bulk.
- Apply selected state to test structure.

#### Build

- Build tests via `СборкаТекстовСценариев.epf` from SPPR.
- Build parameters manager with two sections:
  - `SPPR build parameters` to generate `yaml_parameters.json`;
  - `Additional Vanessa Automation parameters` for `VAParams` keys that SPPR processing does not support (for example, `gherkinlanguage`).
- Run Vanessa Automation from Test Manager for a specific built scenario:
  - a top Vanessa run button in the panel opens mode selection (`run` / `debug`);
  - in `debug` mode no scenario selection is required: Vanessa opens immediately with parameters from `Additional Vanessa Automation parameters`;
  - `debug` mode is available even when there are no built scenarios;
  - in `run` mode a scenario picker is shown after mode selection;
  - run icon near a scenario starts a standard run immediately (without a dropdown menu);
  - dedicated runtime folder for logs/status (`runVanessa.runtimeDirectory`);
  - separate Output channels for build and Vanessa run logs (`KOT Test Assembly` / `KOT Test Run`);
  - command template support (`runVanessa.commandTemplate`);
  - `Open run log` button that opens the scenario log file;
  - stale indicator when related scenarios changed after build.
- `Favorites` tab in Test Manager provides quick open/remove actions and in-panel sorting.
- (_1C:Drive_) Build FirstLaunch archive.
- Drive-specific build UI controls (`Build FL` and accounting mode selector) are controlled by `kotTestToolkit.assembleScript.showDriveFeatures` (**General settings**, disabled by default).

## Quick start

1. Install the extension from [Marketplace](https://marketplace.visualstudio.com/items?itemName=AlexeyEremeev.kot-test-toolkit) or from `.vsix`.
2. Open repository root in VS Code.
3. Configure minimum required paths (details: [Technical setup (EN)](./docs/SETUP.en.md)):
   - `kotTestToolkit.paths.yamlSourceDirectory`
   - `kotTestToolkit.paths.oneCEnterpriseExe`
   - `kotTestToolkit.paths.buildScenarioBddEpf`
   - `kotTestToolkit.assembleScript.buildPath`
4. Open `scen.yaml`, invoke context menu, and try `KOT - ...` commands.

## Detailed setup and commands

Technical guide is provided separately:

- [Техническая настройка (RU)](./docs/SETUP.ru.md)
- [Technical setup (EN)](./docs/SETUP.en.md)

## Code documentation

- [Документация по коду расширения (RU)](./docs/DEVELOPMENT.ru.md)
- [Extension code documentation (EN)](./docs/DEVELOPMENT.en.md)

## Experimental features

By default, diagnostics focus on local scenario and related parent scenarios. Global scan is kept as a technical command: `KOT - Scan workspace diagnostics`. On large repositories, global scan can create high load.

## Screenshots

<div align="center">
  <p><em>Test Manager in Activity Bar</em></p>
  <img src="https://raw.githubusercontent.com/kakoytochelik/KOTfor1C/main/docs/ActivityBar_en.png" alt="Test Manager" width="700" style="max-width: 100%; height: auto; border-radius: 8px;"/>
</div>

<div align="center">
  <p><em>Build parameters manager</em></p>
  <img src="https://raw.githubusercontent.com/kakoytochelik/KOTfor1C/main/docs/parametersManager_en.png" alt="Parameters manager" width="900" style="max-width: 100%; height: auto; border-radius: 8px;"/>
</div>

<div align="center">
  <p><em>Commands and autocomplete</em></p>
  <img src="https://raw.githubusercontent.com/kakoytochelik/KOTfor1C/main/docs/commands_en.png" alt="Commands" width="650" style="max-width: 100%; height: auto; border-radius: 8px;"/>
  <br><br>
  <img src="https://raw.githubusercontent.com/kakoytochelik/KOTfor1C/main/docs/autocomplete.gif" alt="Autocomplete" width="520" style="max-width: 100%; height: auto; border-radius: 8px;"/>
</div>

## Limitations

- Requires VS Code `1.98+`.
- On macOS, `1C:Enterprise — File Workshop` client is unavailable, so MXL opening is not available.
- Linux support is not tested.

## Contributing

[GitHub Issues](https://github.com/kakoytochelik/KOTfor1C/issues)

## License

MIT. See [LICENSE](LICENSE).
