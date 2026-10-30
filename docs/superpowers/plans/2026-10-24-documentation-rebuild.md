# KOT 3.0.0 documentation rebuild

User-directed editorial work; no product behavior changes. The user authorized a checkpoint commit, full README/documentation rewrite and original visual assets.

- [x] Compare current main and shipped behavior; rewrite 3.0.0 notes, update PR, verify and commit checkpoint.
- [x] Rewrite README as a concise capability overview with separate SPPR and Vanessa entry routes.
- [x] Replace all existing user documentation with task-oriented guides; preserve existing page paths and inbound fragment links.
- [x] Add technical references for settings/commands, data ownership, compiler parameters, runtime/MCP, compatibility and development. Generate manifest inventories rather than copy stale values.
- [x] Capture actual UI where reliable, add readable original SVG workflow/interface illustrations; identify screenshots, diagrams and limitations accurately.
- [x] Check all local links/anchors/assets, demo integrity, VSIX image inclusion and rendering; remove unsupported claims.
- [x] Prepare the separate documentation commit and update PR for final scope; verify the remote head after pushing.

Editorial constraints: Russian primary language, SPPR/Vanessa terminology, short overview before detail, clear prerequisites and next actions, technical explanations separated. Do not claim unrestricted MCP capability, native cross-platform 1C execution, automatic translation or live Windows acceptance that was not performed. Keep attribution and release caveats.

Verification: `npm run vscode:prepublish` passed (2571 tests: 2569 pass, 2 skip, 0 fail); `npm run verify:demo` and `npm run docs:check` passed (58 Markdown files, 405 local targets including anchors). Actual macOS editor/settings and Windows MCP Form Explorer/one-step execution were captured; no full Windows acceptance matrix is claimed. Marketplace packaging required PNG exports of the editable SVG diagrams.
