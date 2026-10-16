# Shared project library

The user approved moving KOT groups and metadata into Git-shareable project objects, importing existing YAML metadata and local standalone organization, and adding group creation with consistent headers in all Test Manager sections. Personal favorites, selection, collapse state, runtime artifacts and machine-specific launch paths remain local.

Implementation choices: `.kot/groups.yml` and `.kot/metadata/*.yml` under the workspace root; an external configured test root owns its own `.kot` when its files are outside a workspace. Scenario/process metadata uses UID, with a relative-path fallback for legacy files without UID. Features use project-relative paths. Stored records contain no absolute machine paths. Main/process groups remain shared business groups with independent section projection; standalone groups are distinguished by their section. Empty groups persist.

Project objects are authoritative once present; legacy YAML and workspaceState are imported only for missing records, never used to overwrite shared data on another tester's machine. Keep old YAML readable and do not delete authored blocks automatically. Existing editor mutations must update project objects and refresh all consumers. A tracked object changed by Git must refresh views. Invalid/unsupported project YAML must be reported and preserved without an automatic overwrite. Writes serialize, reread current disk state, and guard conflicting external writes.

Group rename changes the group object, preserving identity and memberships. Both Libraries and Test Manager show the same names/order. All three section headers have creation and new-group controls, identical dimensions/count alignment, and hover/focus visibility; build-disabled creation stays hidden. Existing group + retains Main scenario/Process choice.

Compatibility: retain file URI runtime identity, favorites and compiled links, existing compiler fields, execution profiles, process step identity, and source-navigation behavior. Keep credentials/launch machine paths out of shared files. No live external Drive corpus or EPF changes during development, and no commit/publication requested.

Verification includes cloned roots, UID identity after file moves, empty groups, legacy import idempotence, local launch paths, external Git edits, invalid/conflicting records, and UI hover/focus/build state. Full `npm run vscode:prepublish` is the completion gate.

Compiler compatibility decision: shared objects use `.yml`, because the supplied stock compiler recursively reads `*.yaml` and invokes its restricted parser before file-type guards. This keeps project objects outside compiler inputs even for external roots. A known-scenario-key ledger distinguishes newly discovered sources from Git-deleted records; duplicate UIDs are rejected before any import write.
