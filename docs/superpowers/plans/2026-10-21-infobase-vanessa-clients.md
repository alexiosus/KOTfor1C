# Infobase Manager and Connect Vanessa Implementation Plan

> Исторический первый этап. Уточнение без чекбоксов, Connection details и активные запуски описаны в [следующем плане](2026-10-21-infobase-client-refinement.md).

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline, task by task. No new agents or worktree required for this already active user branch. New feature edits start after the explicitly requested checkpoint commit `67c6de5`.

**Goal:** manage saved users/client profiles per infobase, apply/connect/disconnect selected profiles in Vanessa, and separate Connect Vanessa from connection settings and legacy process launches.

**Architecture:** extend the existing Debug client store into a shared local catalog without changing its selected Debug set. Reuse the existing MCP session and client adapter through a dedicated service; full Infobase Manager owns the shared editor, sidebar actions open that editor for the chosen base. Public webview state contains identities/status and secret-presence flags, never passwords, full credential strings or extra launch parameters.

**Tech Stack:** existing TypeScript, VS Code SecretStorage/workspaceState, HTML/CSS/JS webviews, existing MCP client/session.

**Spec:** [connections and current element](../specs/2026-10-21-vanessa-connections-and-current-element.md), sections Подключение менеджера and База → пользователи → клиенты Vanessa. All changes stay in version 3.0.0.

## Global Constraints

- Preserve legacy Debug/process launch commands and selected defaults. Connect never runs a feature or implicitly connects test clients.
- Store credentials and additional launch keys in the existing SecretStorage payload; do not add a second secret store or shared project secrets.
- Check normalized base/user/client type and supported fields, not only a profile name. Conflicting/ambiguous profiles never receive an implicit overwrite.
- `.45` cannot set/verify a saved port through profiles API; show this limitation in the editor. Do not label the complete saved profile as applied.
- Disconnect does not close a process. `.45` disconnect only supports the single confirmed current client; refuse ambiguous multiple-client disconnect.
- Read-only refresh never connects/launches clients. Recheck generation before/after remote operations, serialize mutations, preserve partial results and refresh confirmed status on failure.

## Review Focus

- Catalog edits must not add all infobases to the selected Debug launch set or drop unrelated saved users.
- Stale base/row IDs, canceled credentials dialogs and changed sessions must not target another client.
- Same-name/different-base profiles, alternate names for an equivalent client, and ambiguous matches need explicit conflict states.
- Missing secure payload must fail without replacing authentication with empty values; no secret may enter webview state or errors.
- Multi-selection requests must preflight all selected clients, then report the actual post-operation state even after a partial failure.

### Task 1: Shared local catalog

**Files:** modify `src/vanessaDebugClients.ts`; tests `test/vanessaDebugClients.test.ts`.

- [x] RED: load old v1 selection as a catalog; add an unselected base user while preserving Debug selection; edit/delete selected entries consistently; maintain secure-storage rollback and serialize saves from multiple store instances.
- [x] Add `loadCatalog(): Promise<readonly VanessaDebugClient[]>` and `saveCatalog(clients): Promise<void>` backed by the same public identities/SecretStorage payload. Existing `load/save` keep their Debug-selection meaning and preserve the broader catalog.
- [x] GREEN: focused store/configuration/launch tests (33/33).

### Task 2: Client reconciliation and actions

**Files:** create `src/vanessaInfobaseClients.ts`, `src/vanessaInfobaseClientCommands.ts`, corresponding tests; modify extension wiring only after the service is tested.

- [x] RED: base filtering, safe DTOs, duplicates/conflicts, existing equivalent profile reuse, missing profile creation, connected skip, unsupported port, partial failure, changed generation, local secret editing and deletion without remote side effects.
- [x] Implement catalog CRUD with host-chosen infobase identity; native secure dialogs only for password/launch keys; generation-bound list/apply/connect/disconnect with post-read verification and explicit conflict replacement.
- [x] GREEN: adapter/service command tests, no credentials in public state/errors.

### Task 3: Infobase interfaces and Connect/settings

**Files:** `src/infobaseManagerPanel.ts`, `media/infobaseManager.js`, `media/infobaseManager.css`; sidebar provider/protocol/model/extension operations as needed; `src/vanessaControlConnection.ts`, `src/phaseSwitcher.ts`, `media/phaseSwitcher.js`, package/localization files.

- [x] RED: full manager client table has per-user/all checkboxes and separate Add/Connect/Disconnect actions; sidebar opens the same editor for its base; no credential payloads in webview protocol; canceled operations recover controls.
- [x] Implement reusable per-base editor with local profile fields and native credential buttons; selection/status/pending states, explicit refresh and visible port limitation.
- [x] Add Connect Vanessa and Connection settings commands/buttons; preserve legacy process/Debug launch entry under settings/palette. One connect action uses discovery/managed-start and never runs a feature or applies clients.
- [x] GREEN: UI/protocol/connection integration tests, local webview preview. No live user session was changed; a separate live acceptance of the new interface remains outstanding.

### Task 4: Documentation and final gate

- [x] Update 3.0.0 changelog, current connection spec and capability matrix to implemented scope; keep actual upstream limits explicit.
- [x] Run `npm run check`, `npm run compile`, diff check and review changed files. No new commit/push/release unless the user requests it.

## Execution ledger

- Checkpoint required by user completed first: `67c6de5`, 200 files, clean tree, full `vscode:prepublish` 2324 passed/2 skipped. Changelog folded into 3.0.0; no version bump or push.
- Ruling: retain storage version 1 with an optional catalog, sharing the same secure payload and an independent selected Debug subset. `updateCatalog` executes against the latest state under a cross-instance write lock; manager edits must use it rather than replacing a stale whole catalog.
- Task 1 RED 3 missing methods → GREEN 33/33 store/configuration/launch tests; type check passed.
- Task 2 core and pure host-action handler implemented but not wired to UI yet: per-base safe DTO, conflict/identity reconciliation, CRUD, native secret-dialog ports, all-selected preflight and post-read verification. Additional adapter expectations reject replaced profiles before apply/connect. Core/host tests 12/12 and adapter tests 10/10. Duplicate-equivalent replacement and disappearing-before-connect regressions reproduced RED, fixed GREEN.
- Ruling: the compact sidebar opens the same per-base editor in full Infobase Manager, rather than duplicating credential forms in a narrow surface. The shared editor exposes user/profile selection for both entry points.
- Task 3 complete: full-manager editor, sidebar/Form Explorer entry, live status refresh only while visible, native secrets dialogs, separate Connect/settings. Managed Connect bypasses the legacy Debug set and does not execute a feature. Protocol/native-cancel integration tests and browser preview of Add user, tri-state selection and selected action passed.
- Independent review reproduced Debug order drift, indistinguishable MCP selections, selected name/synonym collisions, unquoted/ambiguous username parsing, and unavailable-SecretStorage recovery. All fixed with RED→GREEN regressions. Replacement is bound to a host-only profile/generation snapshot; store reads serialize with secret rotation. Recovery requires re-entered data and explicit whole-catalog confirmation, refusing reset if the catalog recovered meanwhile.
- Full `npm run check`: 2358 total, 2356 passed, 2 optional skips, no failures. `npm run compile` and `git diff --check` passed. Independent follow-up review: all findings resolved, 67 focused tests passed, no new substantial findings. Version remains 3.0.0; no new commit/push. Temporary preview server stopped; separate live acceptance of the new UI remains outstanding.
