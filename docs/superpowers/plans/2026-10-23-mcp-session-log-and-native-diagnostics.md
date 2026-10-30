# Session logs and native SPPR diagnostics follow-up

Continue inline in the shared workspace, preserve unrelated changes, keep version 3.0.0. No commit requested.

Root causes: attached managers lose the in-memory log binding; native scripts take the generic feature diagnostics branch; sidebar focus-within padding outlives visible controls and grid buttons clip their padding; Parallels hard links return EINVAL outside the existing fallback list.

- [x] Give every managed MCP port a stable execution log shared by all its features; keep step logging enabled in its private launch JSON.
- [x] Recover reconnect/reload bindings from the actual local 1C listener's private KOT VAParams, accepting only unchanged startup files with enabled logging. Return no command line or credentials from process inspection. Keep explicit external-log selection.
- [x] Track every scenario within the bound feature, including parameter variants and uncatalogued scripts. Preserve whole-feature mode during the last log read. Never substitute another artifact's log.
- [x] Reuse SPPR diagnostics for native scripts with adjacent metadata, keeping feature coordinates and syntax checks. Update open script diagnostics when metadata changes and use its defaults in missing-argument quick fixes.
- [x] Match base/client icon sizing, remove client-management buttons from client rows, and limit action padding to hover or visible keyboard focus.
- [x] Cover EINVAL fallback for conversion, exclusive creation and rollback.
- [x] Run complete checks/compile and inspect the active Windows DevHost where available.

Focused verification before the final gate: 143 tests passed. Includes explicit current-session consent with two feature files using the same recovered log, per-session log creation/recovery, all compiled scenarios, native missing parameters and compiler blocks, and Parallels copy fallback/rollback.

Final verification: `npm run check` passed (2519 tests: 2517 passed, 2 skipped), `npm run compile` passed, and `git diff --check` passed. The final log ownership regression also passed: an MCP run suppresses the external auto-detected watcher for its bound log and deselects an older tracked source before starting.

Windows DevHost acceptance in Parallels: reloaded the extension while keeping Vanessa open; Execution log automatically showed the existing manager's actual legacy MCP log. The cold process query took 2016 ms, exceeding the former 2000 ms timeout; the one-time attach query now permits 5000 ms. Ran the compiled two-scenario KOTMAIN feature with the existing session settings and accepted its stale-artifact warning. After completion, confirmed green highlights in Background and both parameter variants, and Vanessa remained ready. No infobase relocation/copy setting was selected. Native diagnostics and EINVAL rollback were verified by automated tests, not by changing the user's scenario files or infobase settings.
