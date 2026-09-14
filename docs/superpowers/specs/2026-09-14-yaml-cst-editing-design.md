# YAML CST Editing Design

## Goal

Replace regular-expression parsing of YAML structure with parser-backed navigation while preserving the original file byte-for-byte outside the exact field or section being edited.

## Scope

- Parse scenario YAML through `yaml@2` and use node ranges to locate top-level sections, scalar fields, and sequence records.
- Keep the public helpers in `yamlHeaderFields.ts` compatible so callers can migrate without a broad behavior change.
- Replace structural regular expressions in `commandHandlers.ts` that locate `ВложенныеСценарии` and `ПараметрыСценария`.
- Preserve regular expressions that intentionally parse the Gherkin text inside `ТекстСценария`.
- Validate parser compatibility against the read-only 1C:Drive scenario corpus.

## Explicit Exclusions

- Do not modify `steps.htm`, `stepsFetcher.ts`, completion generation, or IntelliSense behavior.
- Do not modify the AI flow.
- Do not serialize the complete YAML document after a local edit.
- Do not normalize comments, quoting, key ordering, blank lines, BOM, or line endings.

## Problem

Current helpers infer YAML structure from indentation and regular expressions. This breaks or becomes ambiguous around quoted scalars containing `:` or `#`, comments, empty sections, varying indentation, CRLF files, and block scalars. Replacing a whole document through a YAML serializer would solve parsing but create large unrelated diffs and discard user formatting.

## Architecture

Add a pure `scenarioYamlDocument.ts` adapter around `yaml@2`. The adapter parses once, exposes domain-specific lookups, and translates YAML node ranges into source offsets. It never owns VS Code objects and never writes files.

Edits remain minimal text edits:

1. Parse the current source and reject structural mutation when the document has parser errors.
2. Find the target map pair or sequence node through the YAML AST.
3. Derive the smallest safe source range from node ranges and surrounding line boundaries.
4. Return an offset/range and replacement text to the existing VS Code command.
5. Leave all source outside that range unchanged.

This hybrid deliberately uses CST/AST navigation for YAML and keeps domain-specific rendering for the small section body being replaced. It avoids whole-document serialization.

## Public Model

`scenarioYamlDocument.ts` exports:

```ts
export interface SourceRange {
    start: number;
    end: number;
}

export interface ScenarioYamlField {
    key: string;
    value: unknown;
    pairRange: SourceRange;
    valueRange: SourceRange | null;
    lineStart: number;
    lineEnd: number;
}

export interface ScenarioYamlSection {
    name: string;
    pairRange: SourceRange;
    valueRange: SourceRange | null;
    bodyRange: SourceRange;
    keyIndent: string;
    itemIndent: string;
}

export interface ScenarioYamlRecord {
    key: string;
    fields: ReadonlyMap<string, unknown>;
    range: SourceRange;
}

export class ScenarioYamlDocument {
    static parse(source: string): ScenarioYamlDocument;
    readonly errors: readonly string[];
    findField(sectionName: string, fieldName: string): ScenarioYamlField | null;
    readScalar(sectionName: string, fieldName: string): string | undefined;
    findSection(sectionName: string): ScenarioYamlSection | null;
    readRecords(sectionName: string): readonly ScenarioYamlRecord[];
    requireValidForEdit(): void;
}
```

The implementation may add private helpers, but callers must not depend directly on `yaml` node classes.

## Error Handling

- Read-only lookups return no result for a missing section or field.
- Mutating commands abort with a localized error when parser errors make a target range unsafe.
- No regex fallback is used for YAML structure because silently selecting the wrong range is worse than refusing an edit.
- Incomplete text inside `ТекстСценария: |` remains valid block-scalar content and does not affect structural navigation.

## Compatibility Strategy

- Preserve the current exported signatures of `buildYamlHeaderFieldLine`, `findScenarioHeaderFieldLines`, `findTestSettingsFieldLines`, and `parseYamlSectionFieldValues`.
- Preserve existing section-body renderers and snippets; only range discovery and record reading move to the parser adapter.
- Preserve source BOM and detect the current newline sequence when producing insertions.
- Use fixture tests for deterministic CI. Run the external 1C:Drive corpus as a separate read-only compatibility command.

## Acceptance Criteria

- Unit tests cover comments, quotes, `:` and `#` inside values, Cyrillic keys, BOM, CRLF, block scalars, empty sections, and sequence records.
- Header helpers no longer locate YAML keys with structural regular expressions.
- `commandHandlers.ts` no longer uses regular expressions to find the boundaries of `ВложенныеСценарии` or `ПараметрыСценария`.
- Gherkin parsing regular expressions remain unchanged.
- All 1,885 external `scen.yaml` files parse without a fatal YAML error.
- Existing checks pass and the external corpus remains unchanged.

