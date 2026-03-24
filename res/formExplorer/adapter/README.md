# 1C Form Explorer Adapter Source

This folder contains the source template used by the generated `KOT Form Explorer Runtime` extension.

Files:

- `KOTFormExplorerAdapterClient.bsl`
  Base client module text that the generator extends with runtime support code, settings handling,
  auto/manual mode switching, and snapshot serialization helpers.

## Primary usage

The normal workflow is **not** manual copy-paste into a project.

Instead:

1. Configure `kotTestToolkit.formExplorer.*` settings in VS Code.
2. Run `KOT - Generate Form Explorer extension project`.
3. Build and install the generated `.cfe`.

The generator reads this source file, appends configuration-specific support code, and produces the
runtime module inside the generated extension project.

## Manual usage

If needed, this file can still be used as a starting point for a custom 1C-side integration, but it
is no longer documented as the primary path.

For the supported end-to-end workflow, see:

- `documentation/blocks/form-explorer.md`
