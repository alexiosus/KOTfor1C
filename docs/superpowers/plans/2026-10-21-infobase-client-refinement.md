# Infobase client refinement and active Vanessa workflow (3.0.0)

User request: seventeen follow-ups dated 2026-10-21, applied to the existing working tree without a version bump or implicit commit.

## Accepted behavior

- Full manager: collapsible test-client group, icon-only Refresh/Add, no connection toolbar/hints/selection counters; per-row Add (only absent), Connect/Disconnect and edit. Inline password and launch keys in Connection details; retain secure local persistence while making the requested fields editable.
- Names identify distinct Vanessa profiles. Same-base, same-name changed settings are a pending update, applied explicitly through the row; foreign-base/ambiguous identity remains a conflict. Observe external rename without showing a second contradictory name.
- Sidebar: bases disclose client children and confirmed runtime modes. Normal Enterprise/Designer starts retain process modes; MCP clients expose connected state. Do not claim knowledge of unrelated external processes.
- Full manager common actions stay visible; less frequent actions move to per-category menus. Open with Vanessa/Form Explorer chooses a saved profile for the selected base, then connects it through Vanessa.
- Connect button handles session start/controls, settings move into Test Manager menu; auto-start is opt-in. Completion uses shared cached MCP data on demand even when Form Explorer is closed.
- Fix compiled Properties run, feature source selection, stale confirmation, and reuse of active MCP manager with correct parameters. Preserve compatibility process path.
- Verify whole-YAML trial reuse against SPPR syntax before proposing performance changes. Answer feature support from local SPPR/compiler primary sources.

## Work and verification

1. Root: client reconciliation/update/rename, inline editor, manager actions, sidebar clients/runtime modes and central extension wiring; meaningful RED→GREEN cases for behavior.
2. Run-path agent: item14 and safe optimization investigation16, local parser/source/managed-run tests.
3. Connection/completion agent: items11–13/15, independent lifecycle/cache/menu tests; extension hooks integrated by root.
4. Research agent: read-only primary-source audit for16/17; later scoped review if needed.
5. Update 3.0.0 docs/changelog; run full check and compile, review all changed behavior. UI preview uses test data; live session changes only on an owned acceptance client.

No commit/push is requested for this follow-up. Previous checkpoint remains 67c6de5.

## Result and evidence

- Client table and sidebar refinement implemented; profiles use explicit name identity, same-base updates, guarded remote replacement, observed rename adoption, inline editor ownership and confirmed base/client modes. Runtime status survives a busy command in the same generation.
- Run defaults to MCP; explicit process remains available. Compiled Properties/source targeting and stale-artifact reload are covered. Matching managed configuration or explicit current-settings consent is reused for the connected generation. Consent does not prove that another JSON was applied.
- Connect/Control, optional auto-start, cached form completions with the panel closed, categorized actions and context menus implemented. Issue13 prepared for runtime VAParams; not published.
- Final gate: `npm run check`: **2388 total, 2386 passed, 2 skipped, 0 failed**. `npm run compile` passed. Focused service guard tests, host editor lifecycle, sidebar host identity and default/explicit Run routing are included. Independent review found no remaining substantive issue after the race fixes.
- Production full-manager HTML/CSS/JS preview with synthetic data: separate group and per-row actions, inline editor, save acknowledgment and returned table verified. Screenshot: `/private/tmp/kot-infobase-client-refinement.png`. This is UI evidence, not an actual 1C connection acceptance.
- Windows acceptance DevHost remains visible in Parallels, but F1 and direct guest click did not reach VS Code in this attempt. No client/database state was changed; live acceptance is still outstanding.
- Item16: a whole temporary YAML-derived feature cannot preserve arbitrary SPPR parameter variants/preprocessor/nested-call behavior without compilation, and `.45` calls `ЗагрузитьФичи` inside every execute_feature_step path (`MCPVA Module.bsl:8161–8184`). No unverified performance rewrite added. Existing compiled source maps remain the safe path; upstream issue07 requests execution without reload.
- Item17: supplied SPPR source supports `meta.yaml` + original `scen.feature` (ТестированиеКлиент Module.bsl:2879–2883,3001–3006,3264–3266); the external BDD compiler reads that pair. This finding is not a claim that arbitrary standalone feature files can replace SPPR metadata.
