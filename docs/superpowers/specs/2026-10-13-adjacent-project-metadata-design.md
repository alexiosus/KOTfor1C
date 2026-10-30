# Adjacent project metadata

User approved storing each scenario/process/standalone feature metadata beside its source, using `<full source filename>.kot.yml` (e.g. `scen.yaml.kot.yml`, `process.yaml.kot.yml`, `sales.feature.kot.yml`). Shared groups and migration ledger stay in `.kot/groups.yml`. Preserve existing project objects, Git sharing, personal state, UID identity and compiler exclusion through `.yml`.

Move central `.kot/metadata/<hash>.yml` records to adjacent files automatically after validating the complete source/destination set. Existing adjacent objects win when both exist; report mismatched identity/invalid contents rather than overwrite. Preserve central records if source location cannot be safely established, and report actionable ambiguity. Do not delete an old record until the new file has been written/guarded successfully. Never modify authored source YAML or execute live external corpus migration during development.

Adjacent records derive their current relative source path from the physical sidecar filename, so directory moves/copies don't retain obsolete absolute or relative locations. Scenario/process UID remains in the record; source-only filename moves use the existing rename lifecycle to move the sidecar. Feature relative identity follows its physical source. File deletion and directory deletion include metadata; undo/restore of a folder restores it naturally. Validate duplicate UIDs before migration as before.

All read/edit/watch/open actions use adjacent files; dirty editor guards cover both groups and sidecars. Watch sidecars inside and outside configured test roots. Keep legacy central read/migration compatibility, serialization/conflict guards, group projection, and local JSON bindings. Core APIs remain unchanged where possible.

Tests cover migration precedence/conflicts, directory relocation, source-only renames, deleting files/folders, personal JSON retention, invalid sidecars and stock compiler '*.yaml' exclusion. Final gate: `npm run vscode:prepublish` plus diff check.
