# Project format and regional compatibility

Approved by user: implement the proposed per-branch format gate. Continue in the current dirty feature checkout; preserve prior work. No release/commit/push or Parallels.

- `.kot/project.yml`, exactly `version: 3`, explicitly opts the owning project into KOT 3 metadata and source-format automation. Missing marker means legacy; malformed, conflicted, symlinked or unsupported marker fails closed for managed writes. A global/user setting cannot override it.
- Legacy project discovery is read-only: show inline KOTМетаданные groups/descriptions/categories, ignore leftover v3 sidecars/catalogs, never remove inline fields or create organization files. Regular source editing, existing YAML compilation and runs remain available. Properties metadata edits write the inline YAML fields; creation defaults to unified YAML even if user defaults prefer native. Native conversion/save migration requires v3.
- V3 group metadata remains sharded and UI order remains local. Enforce the marker again at guarded writes so branch changes cannot use stale in-memory permission. Invalidate source/catalog/Properties snapshots on marker and Git branch/index changes. Core and regions use their own project roots and existing project parameter-profile isolation.
- Setup works without opting in: inspection, paths, profiles and execution settings may be configured while preserving legacy format. Existing projects must explicitly choose a transition (including CI readiness) in the reviewed setup plan. Only this transition writes the marker before authorized import; failed/cancelled setup must not implicitly enable it. New projects created by the reviewed wizard opt in explicitly as part of creation.
- New-layout-only group CRUD/conversion actions in legacy mode explain the required transition; do not silently create sidecars. Preserve existing inline metadata editing and group assignment.
- Prepare marker files only in this repository/demo and the already transitioned 1cDrive checkout; never opt in other repositories/branches.

Review focus: missing/stale/conflicted markers; branch switch during async writes; saved old wizard completion; native defaults/auto-migration leaking into regions; source bytes unchanged on discovery; inline metadata values preserved through explicit edits; multiple windows/roots; setup cancel/failure.
