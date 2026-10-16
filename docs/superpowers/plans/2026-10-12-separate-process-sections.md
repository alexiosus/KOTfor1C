# Separate process sections

Approved scope: processes get their own source in both Library views and their own section in Test Manager. Business group metadata/order and URI-based build selection remain shared; same-named groups may appear independently under both entity sections.

- [x] Library source/count/type separation, preserving item IDs, favorites, process actions and compiled resources.
- [x] Full/compact Library projection, source icons, group menus and localization.
- [x] Test Manager collapsible Main scenarios and Processes sections with isolated group DOM/expansion keys and shared real group names; preserve search/filter/count/selection and creation behavior.
- [x] Regression tests for identical group names, empty sections, selection and source/action compatibility.
- [x] Integration review, documentation and full release gate.

Validation: `npm run vscode:prepublish` passed (1261 tests passed, 2 skipped), including type checks, lint and production bundle. Independent review passed 27 targeted tests and found no remaining issues in the separation scope. Source localization and search/collapse animation regressions were fixed and covered; group creation retains both types in one dropdown.
