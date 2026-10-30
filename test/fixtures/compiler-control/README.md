# Compiler control live fixture

`compiled-control.live.json` is a first-party, disposable acceptance set compiled on Windows 2026-10-18 with 1C `8.5.1.1522`. The exact EPF SHA-256 is in the fixture. It contains no Drive business scenarios or credentials: only Delay steps, a repeated nested call, two parameter combinations, and a process containing a child process and another scenario step. Two compiler workers wrote separate output namespaces.

The YAML sources, generated feature text and `.str` entries came from that real compilation. Temporary paths were replaced with fixed acceptance paths; source map JSON was reformatted. Hashes used by the regression test are computed over these sanitized bytes, not claimed to be the original build hashes. Original input/output hash verification was checked separately in the disposable runtime.

Both workers returned result `0` and successful compilation JUnit. The nested Delay maps to eight distinct invocations across the grouped parameter variants and the nested process. All eight reverse-map to the exact YAML line. One chosen compiled Delay was executed through the production MCP session adapter, with saved editor content verified; it passed and Vanessa selected the next mapped line. No TestClient was connected and no complete generated scenario or business step was run.
