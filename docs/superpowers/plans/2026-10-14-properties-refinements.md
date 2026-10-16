# Properties sidebar refinements

Keep ordinary YAML documents and the Secondary Side Bar. Show the source model before related settings/groups finish loading; discard stale enrichment when the active source changes. Preserve document revisions and serialized edit acknowledgements.

Edit identity through fields while reusing existing project rename/code workflows. System functions select a configured name/UID pair. Project, report levels and user profile remain stock string fields, with suggestions from defaults and project YAML rather than mandatory KOT catalogs. Hide raw identifiers and derived row numbers from the form.

Generated nested/parameter sections have no structural controls. Manual mode offers Fill from scenario text. Parameter rename updates compiler substitutions in this source only, including tables/docstrings but excluding comments and escaped brackets. Display direct usage counts. Put metadata after Header, tags after Nested scenarios and settings in a separate tab.

Validate source-preserving edits, guarded asynchronous loads, identity value arguments, generation policy, UI controls/layout and the full prepublish gate. Document Pin and Cartesian parameter combinations.

Implemented: staged source/enrichment with cache and generation guards; explicit mutation acknowledgements (including non-acknowledging ready handshake); pruning deleted auxiliaries; independent inline identity edits with UID-linked variants/process references and native editor reload synchronization; descriptive source-step dropdowns; generated-list policy, usage counts, hidden IDs/row numbers, settings tabs and compact effective-parameter previews. Unpin follows the current editor immediately.

Validation: focused queue/ready, deletion, stale-load and compiler-source compatibility regressions; full vscode:prepublish gate; DOM and screenshot inspection at 340/700px in light/dark themes (no horizontal overflow). Browser native click delivery was unavailable; tab behavior is covered by the webview tests. No extension install, release, commit or external compiler invocation.

Final gate: `npm run vscode:prepublish` — 1489 passed, 2 skipped, 0 failed; type/lint checks and minified extension bundle succeeded. Evidence: `/private/tmp/kot-refine-verified-gate.log`.
