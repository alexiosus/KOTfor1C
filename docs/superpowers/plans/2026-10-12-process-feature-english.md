# English process output correction

Scope: reproduce `/Users/alexeremeev/Development/1cDrive/.vscode/kot-runtime/tests/EtalonDrive/2345323.feature` and adapt KOT build output without modifying the stock EPF or authored YAML. The compiler sets `#language: en` but `ТекстПроцесса` omits `МногоязыковаяПоддержка`, leaving Russian structural headers and generated TestClient steps.

- [x] Regression tests for stock English process headers, nested scenario/subprocess groups and generated connection/window steps.
- [x] Line-preserving normalization limited to English compiler process artifacts; retain business steps, strings, tables, docstrings, tags, BOM/newlines and `.str` coordinates.
- [x] Apply normalization while merging completed compiler outputs, including partition/model database folders; preserve attached files and maps.
- [x] Verify against a temporary copy of the reported external feature, scoped review and release gate; document the correction and scope.

Validation: npm run vscode:prepublish passed (1247 passing tests, 2 skipped, type checks, lint and production bundle). The supplied feature was transformed in memory and saved only as a temporary preview: 163 lines retained, all six generated connection steps corrected, no remaining broken Russian headers/window steps, credentials unchanged, idempotent output. Source feature/EPF/YAML were not edited. Independent review verified mixed newlines, docstrings/tables, all worker/model namespaces and maps; its JSON attachment finding was reproduced and repaired with byte-preservation coverage.
