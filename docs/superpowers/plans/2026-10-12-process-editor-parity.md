# Process editor follow-up

User scope: emit compact process steps, restore YAML highlighting and management controls for processes/settings, explain compiler parameter/tag sections, include process dependencies and an editable step list in the Library detail column.

- [x] Emit only scenario or nested-process reference fields for newly created steps.
- [x] Recognize visible process/settings YAML without changing hidden document models.
- [x] Add header controls, independent process name/code editing, UID-linked settings navigation and shared database/user pickers.
- [x] Preserve references, parameters and custom settings during identity edits; reject stale/ambiguous edits.
- [x] Include process dependencies and order editing in the Library detail column using existing process mutations.
- [x] Document actual compiler parameter precedence, examples and limitations.
- [x] Review changes and run the full release gate: TypeScript, lint, 1190 passed tests, 2 skipped, minified bundle. Review repairs include exact source URI, duplicate UID, dirty settings, required nonempty code, scenario-only command separation, picker URI/version guards and explicit stale-artifact notification.

External compiler sources remain read-only. No EPF execution is available in this validation.
