# Follow-up 2026-10-23, release 3.0.0

User nine items: fix Infobases marker/chip/action geometry and always-available compact client action; expose conversion in Properties and both Library menus/details; native SPPR navigation/syntax/metadata synchronization/folding; live full-feature results via the actual manager log; visible format preference.

Implementation uses the existing row controls and metadata editors. Native script is a fragment, not an independently required complete Gherkin feature. Metadata identity remains stable while source navigation resolves the paired script. Synchronization preserves existing defaults and does not automatically save metadata that was already dirty. Bound source versions protect writes. Ordinary YAML save routing remains unchanged.

Each managed MCP launch receives its own execution log in the temporary VAParams overlay. The path is passed to tracking only for its attachment generation; external sessions can explicitly bind an existing log. No inference from another artifact's JSON and no unsupported claim of changing live Vanessa settings.

Validation: targeted RED/GREEN native navigation/fragment syntax/parameter refill, synchronization lifecycle, Library conversion identity, managed log configuration and session binding. Production UI preview on synthetic data confirmed fixed Connect/Disconnect coordinates and non-overlapping sidebar marker columns. Final `npm run check`: 2435 total, 2433 passed, 0 failed, 2 skipped; type checks and lint passed. `npm run compile` passed. `git diff --check` passed. No new live 1C full-run acceptance is claimed.

Live acceptance retry in Parallels succeeded after focus was restored: the Development Host reloaded, Properties exposed conversion, previous native-feature diagnostics disappeared, and Run from Properties executed both scenarios of the own fixture in the active managed MCP session. The first scenario still lost its colors. The generated overlay supplied a log path but omitted enabling text logging and per-step logging. Confirmed both flags against Vanessa .45 source (`ВыводитьВЛогВыполнениеШагов` gates step records), added RED/GREEN regression assertions including preservation of false source/ordinary Debug values, and enabled both only in managed MCP overlays. A second live launch confirmed creation of the actual session log with scenario records; it preceded the per-step flag fix.

After the final fix, `npm run check` again passed: 2435 total, 2433 passed, 0 failed, 2 skipped; compile passed. Final live acceptance with both flags remains pending: UI input returned `noWindowsAvailable`, then automatic action review could not complete because of the account usage limit (retry at 03:18). This was not a safety rejection. The own fixture was restored byte-for-byte; no production tests were changed. Do not claim live full-feature coloring is confirmed yet.

## Additional follow-up

- [x] Treat only a validated adjacent SPPR pair as compiler script in completion, hover and semantic highlighting; read parameter defaults from current metadata buffer. Keep standalone feature rules unchanged.
- [x] Return URI moves from conversion, refresh the Library inventory and avoid waiting on a nested Properties open from its action queue. Carry script text separately for usage counts; never save a composed parser view.
- [x] Commit and queue Save on pointer press before blur can replace the button. Test one-click saving of a default value.
- [x] Add opt-in on-save legacy conversion using the existing guarded transaction. Preserve unsaved companions and keep manual conversion available.
- [x] Remove sidebar inline client management, release hidden action width; save Vanessa-only clients locally with their observed credentials and launch keys, without runtime mutation.
- [x] Run focused regression tests, then check/compile; clarify which Vanessa issues remain relevant.

Execution continues inline under the user's ongoing implementation request. Version remains 3.0.0; no commit requested for this follow-up.


Follow-up verification: `npm run check` passed (2448 total, 2446 passed, 0 failed, 2 skipped), including type checks, tools type checks and lint; `npm run compile` and `git diff --check` passed. Added regressions for native fragment completion/defaults/hover/parameter decoration offsets, metadata usage counts, pointerdown Save ordering, notification dismissal independence, deletion during URI moves, opt-in migration scope and remote profile imports including ports on other computers.

Parallels acceptance confirmed Test Manager opens the paired script, Properties offers Open feature before Open YAML, native compiler syntax receives semantic coloring, and both conversion directions complete to Saved after removing the awaited notification. Repeated conversion exposed a watcher delete event arriving during the source move; fixed it and reproduced it with a panel integration test. Final watcher handling, one-click Save, profile import and bracket decorations are covered by automated tests; no claim of final live acceptance for every control. The temporary own fixture and its ledger key were removed. Existing user scenarios were not edited. Prior full-run MCP coloring acceptance remains a separate pending item above.

Vanessa drafts 11 (structured state/results and run enumeration) and 13 (runtime VAParams) remain relevant to the checked .45 API. Text-log tracking is a workaround; it does not add those MCP capabilities. Current upstream develop is not claimed verified.

Final DevHost reload was not completed because palette shortcuts did not reach the intended control. Accidental input into the previously clean user feature buffer was removed and discarded without saving; its disk contents were unchanged. The compiled bundle is ready and requires Reload Window to load the last fixes.
