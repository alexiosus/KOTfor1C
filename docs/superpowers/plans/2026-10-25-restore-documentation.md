# Restore Documentation Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this approved audit correction in the current session. No delegation is needed.

**Goal:** Restore all fifteen documentation gaps identified against 2.7.1 while describing current KOT 3.0.0 behavior.

**Architecture:** Keep README as the overview, restore practical procedures in task guides, and put provider setup, source fields, storage and maintenance contracts in technical pages. Preserve old section addresses with explicit aliases and a checked compatibility inventory.

**Tech Stack:** Markdown, JSON, existing Node documentation verifier, real VS Code screenshots.

**Spec:** [Approved audit](../audits/2026-10-25-documentation-vs-2.7.1.md); user instruction: “Исправь”.

## Global Constraints

- KOT 3.0.0; compare with 2.7.1 at `1f6db371b2f197d450b1593f38785b4b79c2d5f1`.
- Preserve existing source fixes and user edits, especially licensing and replaced screenshots.
- No product behavior change; do not restore removed settings or obsolete UI instructions.
- Provider examples must match `aiClient.ts` and official documentation; no network inference or real credentials needed.
- Label historical screenshots and illustrative output; do not present them as current live evidence.

## Review Focus

- `CreateJson=false`, separate source roots, launch aliases and conditional authentication requirements.
- Literal brackets, multi-level parameter forwarding and distinct source/run-settings UIDs.
- Relative DT paths, hidden bases, file versus server operations, local versus client launch keys.
- Bearer authentication, Azure v1 versus dated deployment endpoints, and absent Git diff.
- Former anchors, new local links, complete audit closure and visual provenance.

## Tasks

- [x] **1. Restore practical guides (D01, D03–D07, D09–D11).** Update parameters, scenario creation, infobases, etalons, navigation and diagnostics. Add source-field reference and bridge procedure. Validate facts against current modules and parse JSON examples.
- [x] **2. Restore AI and developer instructions (D02, D08, D12, D13).** Add five connection examples, error diagnosis, report lifecycle, save pipeline and contributor recipes. Cite official provider/1C/Vanessa sources.
- [x] **3. Restore visual and address coverage (D14–D15).** Capture current missing views where available, retain useful labeled historical animations, add old section aliases near relevant content, and include a fixed 2.7.1 anchor inventory in `docs:check`.
- [x] **4. Verify and close the audit.** Run docs/reference/compatibility and demo checks, inspect all added visuals, map each audit finding to its correction, and report verified limitations.

## Results and decisions

- All D01–D15 have correction links in the audit. README remains an overview.
- `docs:check`: 64 Markdown files; 287 fixed historical section addresses. The new gate failed on missing aliases before restoration and passed afterward.
- Parsed all 88 JSON examples in `documentation`; verified RU/EN manifest descriptions and the compatibility inventory.
- `verify:demo`, `check` (2579 passed, 2 skipped) and `compile` passed. Both new current screenshots were visually inspected; the typo fix was applied and saved in the isolated copy.
- Updated Azure guidance uses official v1 documentation. No real provider request was made. Old AI/formatting media remain explicitly historical; the 6 MB run animation is linked instead of duplicated in the VSIX.
- Current `$$` completion includes global definitions from prior source steps as well as profile GlobalVars; documentation reflects this current behavior instead of copying the older narrower explanation.
- Existing user licensing edits and replaced screenshots were preserved. No product transport or execution behavior was changed.
