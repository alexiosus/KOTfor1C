# Git-friendly KOT metadata

User authorization: choose and implement the optimal design without further approvals. KOT 3.0 is unreleased; migrate our own projects and update 1cDrive CI together. Preserve scenario text, runtime parameters, process steps, identities and group membership.

## Decision and alternatives

Choose one file per group, personal display ordering, per-object metadata and retained deletion history. A growing shared scenario ledger and shared drag ordering produce unrelated Git edits. Keeping the old monolithic groups file plus a merge helper reduces impact but leaves concurrent group creation contending for one array; sharding every catalog entry would introduce excessive file/schema churn. Keep property catalogs and author numbering catalogs in their present formats and merge them by their domain keys.

## Storage

- `.kot/groups/<id>.yml`: version 1, id, name, sections. No shared display order. Existing `ProjectGroup.order` remains an internal compatibility projection until callers no longer need it.
- `.kot/imports.yml`: version 1 and completed imports of embedded metadata/local organization from older KOT. Changes only for an actual import, never on ordinary test saves. No global scenario ledger.
- `.kot/history/<sha256-key>.yml`: version 1 and an identity key, created for explicit metadata deletion or an identity remap that needs a retained tombstone. Existing live sidecars already identify processed objects.
- Adjacent `*.kot.yml`: shared identity, groupId, description and category. Existing order fields are accepted as an initial display fallback; personal drag operations never rewrite these fields or neighboring objects.
- Property/numbering catalogs and project seed profiles retain their paths and schemas.

User revision: no runtime or CI compatibility for the unreleased groups.yml testing layout. Our own group records have already been prepared in the new layout. Use only group records; normal metadata writes retain transaction/snapshot guards. No `.yaml` service files, since SPPR discovers those as compiler inputs.

## Local versus shared

Group and scenario/process/feature display ordering is personal VS Code workspace state, shared between Test Manager and both Library views. Group membership is a project fact used by CI. Moving between groups changes only the moved object's membership; its insertion position is personal. Process step order and scenario execution content remain authored source data. Properties exposes display order as local, not as a shared YAML edit.

## Conflict resolution

Add a Maintenance/command-palette action to resolve KOT metadata conflicts using Git's base/ours/theirs stages. Independent field edits merge; real same-field or delete-versus-edit conflicts require an explicit choice. String sets and historical keys merge without duplicates; groups/system functions/numbering series use stable IDs/prefixes; numbering counters use the maximum while conflicting author changes remain explicit. Validate schema and identities. Show a concrete diff before applying and guard dirty documents, changed files/index stages and symlink/traversal paths. Do not auto-stage, commit or install global Git drivers. Report remaining duplicate test codes or dangling references instead of claiming a fully valid project.

## Acceptance

- Independent new tests do not change common group/import/history files.
- Independent group creation touches different group files.
- In-group display drag causes zero versioned file changes; cross-group drag writes only the moved object's sidecar.
- Both UI surfaces share the personal result; other users/workspaces retain their order.
- Explicit metadata deletion/remapping retains per-object history without a growing global list.
- Conflicts can be resolved through a reviewable action, with tests for additions, deletions, concurrent edits, invalid YAML and stale snapshots.
- 1cDrive CI reads individual group records directly, uses UIDScenarioSettingsFilter, and never transforms or rewrites test sources.
- Verify documentation, localized UI, demo and full extension gates. Perform no Parallels work, merge or release publication.
