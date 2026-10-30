# Nested process follow-up

User scope: add process-in-process selection and an Add process steps action above YAML ШагиПроцесса and in the Test Manager context menu.

- [x] Mixed scenario/process selection for creation, direct insertion and step editing.
- [x] Compiler-compatible TypeШага=1 records; preserve parameters, order and source files of referenced processes.
- [x] Exclude self references, indirect cycles and ambiguous/missing process dependencies; recheck references after selection.
- [x] Add localized YAML CodeLens and Test Manager action using the same command.
- [x] Adapt nested-process filters around the supplied compiler's incorrect ПроцессUID lookup; keep code/settings filter union semantics and disabled-settings isolation.
- [x] Update usage documentation and test creation, editor transactions, structural section detection, reordering and filters.
- [x] Run vscode:prepublish: TypeScript, lint, 1154 passed tests, 2 skipped, minified bundle.
- [x] Independent review and repairs: reject unintended settings-code collisions across the full inventory while preserving an explicitly requested settings-filter union; regression tests pass.

EPF execution has not been exercised. External compiler files and compatibility corpora are read-only.
