# Scenario properties sidebar

Status: accepted, amended by the user to keep ordinary YAML with folded service sections. Properties must be a Secondary Side Bar view that follows the active editor, rather than an editor tab. These latest instructions supersede the earlier text-only projection choice.

## Intent

The user wants to edit a test from one place: scenario text in the editor, with headers, parameters, nesting, test settings and KOT metadata in a separate panel beside it. Today those values require opening the descriptor, a related test-settings YAML and adjacent KOT sidecar.

The form must edit the existing files. It must not introduce another source of settings or change the compiler input format.

## Proposed presentation

One reusable WebviewView named "Test properties" is contributed to the Secondary Side Bar. It follows the active scenario/process YAML editor and resolves a linked settings file by exact UID or an adjacent KOT sidecar by source path and identity. An unrelated editor clears the unpinned view; focusing the properties view retains its bound test. A pin action deliberately retains a selected test.

Opening a visible active compiler YAML editor or its adjacent YAML metadata opens the properties view by default, preserving editor focus. A boolean editor.autoOpenTestProperties setting, enabled by default, allows opting out. Restored editors are initialized; visible-editor lifecycle events retry after language-model replacement. Hidden previews and stale editor instances never auto-open the view. An editor title action, CodeLens and command also open the view with the exact source URI. The source remains an ordinary file document. Collapse populated headers, parameters, nesting, tags and legacy metadata sections while leaving scenario text or process steps expanded. Empty service sections must not accidentally fold the next body. Users can expand any section normally. An explicit Fold service sections action restores the compact presentation.

Auto Save, Undo, completions, hover, definitions, references, diagnostics, Quick Fix and Library insertion retain the existing YAML document lifecycle and providers. No filesystem projection, copied feature or mapped provider subsystem remains. VS Code 1.106 is the minimum version for the Secondary Side Bar contribution.

## Form sections

Use compact collapsible sections on one page, tailored to the selected entity.

1. **Header:** supported scenario/process identity fields, including name, code, system function and UID. UID is shown with copy and source actions; identity changes reuse existing rename/reference-update services instead of a raw single-file replacement.
2. **Scenario parameters:** `ПараметрыСценария`, with add/remove/edit and ordering. Show scalar types, table values, multiple values and outgoing parameter flags using their actual compiler fields. Include a readable preview of generated parameter combinations when applicable.
3. **Nesting:** declarations in `ВложенныеСценарии`, with add/remove/reorder and opening a referenced definition. Builder decision: the scenario panel edits these declarations; actual calls and call arguments in `ТекстСценария` remain authored in the text editor. Declaration order does not claim to change execution order. For processes use `ШагиПроцесса` (scenario or subprocess), performers and `ПараметрыШага`, including incoming references to prior step outputs; here ordering does change execution order. Reuse existing catalog identity and validation rules.
4. **Test settings:** header/link fields, infobase, users and other supported settings from `НастройкаТеста` or `НастройкаПроцесса`, plus `ПараметрыТеста` and `ТегиТеста`. Infobase/users are selected through existing project managers and compatible free-input controls where the current workflow permits them.
5. **Tags:** `ТегиСценария` or `ТегиПроцесса`, separate from test-settings tags.
6. **KOT metadata:** group, order, description and category from `<source>.kot.yml`. Group selection uses `.kot/groups.yml` and the same business objects as Test Manager and Library. Preserve the existing AI description action.

Nested scenarios have no test-settings section unless there is an actual linked settings definition. Processes have no `ТекстСценария`; they use the step list as their authored body. Do not invent a process text field or rewrite process steps as text.

Rows are keyed by stable reference/record identity, never their display position. Reordering updates compiler-required block numbers using existing services. Add actions reuse compiler-compatible field defaults rather than generic YAML structures.

Builder decision: parameter name changes and deletion are local schema edits, not an implicit project-wide refactor. Show a clear consequence message for these operations and existing diagnostics/dependency links for unresolved uses. Do not silently rename literals, body text or callers; automatic parameter refactoring would need a separate authored-reference model and user request. Ordinary value changes do not trigger extra prompts.

## Related files

Resolve the source by exact URI and its current descriptor UID. Resolve test settings through existing compiler linkage. A nearby filename alone is not sufficient.

If several test-settings files refer to the test, show a settings selector inside the panel. Do not silently edit the first match. If no settings exist, show an explicit creation action that uses the existing creation workflow; opening the panel does not create settings. Metadata is created lazily on its first change or explicit open action using the project store. Existing central metadata migration remains the store's responsibility.

## Editing and saving

Builder proposal: edits use VS Code text documents and `WorkspaceEdit`, leaving changes visible as ordinary dirty documents. Display a clear unsaved state and offer "Save test" to save the affected source/settings/sidecar documents together. Do not write through filesystem services over a dirty document. Normal Ctrl+S, Auto Save and Undo keep working in the original YAML editor.

Read open dirty document text before disk text. Update the form after source/settings/metadata changes, including direct YAML editing and Git changes. Clicking into the form must not reset values or cause document language switching.

Apply field/record patches through the source-preserving parser against the current document revision. Preserve comments, newline style, unrelated fields and `ТекстСценария`. Reject ambiguous sections/records and stale overlapping edits with actionable inline errors. New malformed raw YAML disables affected form edits, with a source link; never normalize or overwrite the whole document just to update one field.

Panel writes to KOT sidecars must respect the existing dirty-editor safeguards. Bootstrap a missing metadata object through the store only before a sidecar document exists, then edit the document through the same guarded revision mechanism. Refresh shared projections after a successful save; do not claim that unsaved metadata has been propagated to other testers.

Identity-changing actions use the existing saved-source requirements and update references/settings through their established services. Pending form edits must be applied or explicitly discarded before switching to another test, rather than silently lost.

Saving several files is not a filesystem transaction: report any rejected/failed document saves accurately and preserve remaining dirty edits. Group registry changes reuse serialized store operations and its guards. No form-local persistent duplicate of compiler or KOT metadata is introduced.

## Existing implementation to reuse

- `ScenarioYamlDocument`, scenario descriptors and compiler YAML block helpers for source-preserving field/record edits.
- Process step/edit/identity services and catalog relationships.
- Existing test-settings and infobase/user selection actions.
- `projectLibraryMetadata`, `projectLibraryIntegration` and `ProjectLibraryStore` for KOT ownership, shared groups and sidecar creation/migration.
- Existing webview resource, localization, CSP and message-validation conventions.

Build a focused panel service/model instead of adding another large branch to `phaseSwitcher.ts` or reusing the build-profile parameters panel as test settings. Build profiles remain separate from test-specific compiler overrides.

## Verification required for implementation

Cover descriptor/settings/sidecar linkage (including multiple settings and external roots), dirty document synchronization, stale/ambiguous edit rejection, YAML text/comment preservation, identity updates, table/multivalue/outgoing parameter round trips, nested references, process ordering and correct group ownership. Exercise panel focus/switch/pin behavior without hidden-editor language changes. Verify real webview layout at narrow and wide widths, the Secondary Side Bar view, populated-section folding and native YAML Auto Save.

Run `npm run vscode:prepublish` after implementation, with the existing 1C corpus kept separate from automated tests. Do not claim live compiler/UI verification without executing it. No commit, publication or external Drive migration is authorized by this proposal.

## Builder check

An independent read-only builder check identified two scope questions: declarations versus text calls for scenario nesting, and automatic propagation of parameter rename/deletion. Both are now explicit builder decisions above. The latest user decision is ordinary YAML with folded service sections and a Secondary Side Bar view that follows the active editor.
