# Project Format Compatibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans; execute inline without further approvals. User approved the design by asking to implement it.

**Goal:** One updated extension works with unreleased KOT 3 Core branches and older regional branches without unsolicited source or metadata changes.
**Architecture:** A tracked project format marker controls durable writes and automation. Legacy source metadata is projected/read and edited in place; setup explicitly opts in to v3 independently of ordinary environment configuration.
**Tech Stack:** TypeScript, Node fs, YAML, VS Code, Node test runner.
**Spec:** docs/superpowers/specs/2026-10-30-project-format-compatibility.md

## Constraints and review focus
Preserve current uncommitted work; no Parallels, publish, merge, commit or push. Tests must cover branch changes during writes, malformed markers, old wizard state, native defaults in old projects, cancellation, and multiple roots. Finish with one fresh read-only review under executing-plans.

### Task 1: Durable project format and managed-write guards
- [x] RED tests: absent/valid/invalid markers, root isolation, mode changes and stale write rejection.
- [x] Implement pure format reading plus source-owner helpers; guard store discovery/commits and scope setup deferral to real format.
- [x] Adjust v3 test fixtures to explicitly opt in; prove legacy discovery writes no files and preserves inline metadata.

### Task 2: Legacy editing and source-format policy
- [x] RED tests for inline metadata Properties edits, cold group read, unchanged legacy saves, legacy creation/native-default override and blocked native migration.
- [x] Implement legacy projection/edit adapter; route legacy metadata edits to source YAML and keep v3 sidecars separate.
- [x] Gate creators and native format/batch/callable conversion entry points; leave normal source edits/compile/run intact.

### Task 3: Explicit setup transition and branch refresh
- [x] RED tests: configuring execution without transition, opt-in/cancel/failure, old workspace completion and switch between legacy/v3.
- [x] Add explicit setup choice and reviewed marker write; register branch/marker invalidation and restore legacy state without stale snapshots.
- [x] Update localization, docs and only our already-transitioned marker fixtures.

### Task 4: Verification and review
- [x] Run npm run check, compile, verify:demo, docs:check and whitespace checks; focused temporary real-filesystem branch tests.
- [x] Fresh read-only review of this task's delta; fix important findings with regression tests. Report actual scope and live limitations.
