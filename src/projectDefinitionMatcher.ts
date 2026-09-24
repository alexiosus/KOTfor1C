import {
    normalizeProjectDefinitionTemplate,
    type ProjectDefinition,
    type ProjectDefinitionMatch,
    type ProjectDefinitionParameter,
    type ProjectDefinitionResolution,
    type ProjectDefinitionView
} from './projectDefinition';

const GHERKIN_PREFIX = /^(?:\s*)(?:\*\s*)?(?:К\s+тому\s+же|Допустим|Given|When|Then|And|But|Если|Когда|Тогда|Но|И|If|Дано)\s+/iu;
const BRACKET_PARAMETER_NAME = /^[A-Za-zА-Яа-яЁё0-9_-]+$/u;

interface NormalizedText {
    readonly value: string;
    readonly starts: readonly number[];
    readonly ends: readonly number[];
}

interface CompiledPlaceholder {
    readonly parameter: ProjectDefinitionParameter;
    readonly quote: string | null;
}

export interface CompiledProjectDefinitionMatcher {
    readonly definitionId: string;
    match(invocation: string): ProjectDefinitionMatch | null;
}

const compiledViews = new WeakMap<ProjectDefinitionView, readonly CompiledProjectDefinitionMatcher[]>();

function stripGherkinPrefix(value: string): { start: number; end: number } {
    const prefix = GHERKIN_PREFIX.exec(value);
    let start = prefix?.[0].length ?? 0;
    while (start < value.length && /\s/u.test(value[start])) {
        start += 1;
    }

    let end = value.length;
    while (end > start && /\s/u.test(value[end - 1])) {
        end -= 1;
    }
    return { start, end };
}

function normalizeWithOffsets(value: string, start: number, end: number): NormalizedText {
    let normalized = '';
    const starts: number[] = [];
    const ends: number[] = [];
    let index = start;

    while (index < end) {
        if (/\s/u.test(value[index])) {
            const whitespaceStart = index;
            while (index < end && /\s/u.test(value[index])) {
                index += 1;
            }
            if (normalized && index < end) {
                normalized += ' ';
                starts.push(whitespaceStart);
                ends.push(index);
            }
            continue;
        }

        normalized += value[index];
        starts.push(index);
        ends.push(index + 1);
        index += 1;
    }

    return { value: normalized, starts, ends };
}

function fold(value: string): string {
    return value.toLocaleLowerCase();
}

function findQuotedToken(value: string, from: number): { start: number; end: number; quote: string } | null {
    for (let index = from; index < value.length; index++) {
        const quote = value[index];
        if (quote !== '"' && quote !== "'") {
            continue;
        }
        for (let end = index + 1; end < value.length; end++) {
            if (value[end] === quote) {
                return { start: index, end: end + 1, quote };
            }
        }
        return null;
    }
    return null;
}

function findOutlineToken(
    value: string,
    parameter: ProjectDefinitionParameter,
    from: number
): { start: number; end: number; quote: null } | null {
    const expected = `<${parameter.name}>`;
    const exact = fold(value).indexOf(fold(expected), from);
    if (exact >= 0) {
        return { start: exact, end: exact + expected.length, quote: null };
    }

    const start = value.indexOf('<', from);
    const end = start >= 0 ? value.indexOf('>', start + 1) : -1;
    return start >= 0 && end >= 0
        ? { start, end: end + 1, quote: null }
        : null;
}

function originalRange(
    normalized: NormalizedText,
    normalizedStart: number,
    normalizedEnd: number
): { start: number; end: number } {
    if (normalizedStart >= normalizedEnd) {
        const position = normalized.starts[normalizedStart]
            ?? normalized.ends[normalizedStart - 1]
            ?? 0;
        return { start: position, end: position };
    }
    return {
        start: normalized.starts[normalizedStart],
        end: normalized.ends[normalizedEnd - 1]
    };
}

export function compileProjectDefinitionMatcher(
    definition: ProjectDefinition
): CompiledProjectDefinitionMatcher {
    const matchingTemplate = definition.kind === 'builtInStep'
        ? (definition.template.split(/\r\n|\r|\n/u, 1)[0] ?? definition.template)
        : definition.template;
    const templateRange = stripGherkinPrefix(matchingTemplate);
    const template = normalizeProjectDefinitionTemplate(
        matchingTemplate.slice(templateRange.start, templateRange.end)
    );
    // Nested-scenario parameters live on the following assignment lines, not inside
    // the scenario name matched on the current line.
    const orderedParameters = definition.kind === 'nestedScenario'
        ? []
        : Array.from(definition.parameters).sort((left, right) => left.index - right.index);
    const literals: string[] = [];
    const placeholders: CompiledPlaceholder[] = [];
    let cursor = 0;
    let valid = true;

    for (const parameter of orderedParameters) {
        const token = parameter.source === 'outline'
            ? findOutlineToken(template, parameter, cursor)
            : findQuotedToken(template, cursor);
        if (!token || token.start < cursor) {
            valid = false;
            break;
        }
        literals.push(template.slice(cursor, token.start));
        placeholders.push({ parameter, quote: token.quote });
        cursor = token.end;
    }
    literals.push(template.slice(cursor));
    const foldedLiterals = literals.map(fold);

    return {
        definitionId: definition.id,
        match(invocation: string): ProjectDefinitionMatch | null {
            if (!valid) {
                return null;
            }

            const bodyRange = stripGherkinPrefix(invocation);
            const normalized = normalizeWithOffsets(invocation, bodyRange.start, bodyRange.end);
            const normalizedFolded = fold(normalized.value);
            let position = 0;
            const argumentsFound: ProjectDefinitionMatch['arguments'][number][] = [];

            for (let index = 0; index < placeholders.length; index++) {
                const literal = foldedLiterals[index];
                if (!normalizedFolded.startsWith(literal, position)) {
                    return null;
                }
                position += literal.length;

                const placeholder = placeholders[index];
                let argumentStart = position;
                let argumentEnd = position;
                if (placeholder.quote) {
                    const quote = normalized.value[position];
                    if (quote === '"' || quote === "'") {
                        argumentStart = position + 1;
                        const closingQuote = normalized.value.indexOf(quote, argumentStart);
                        if (closingQuote < 0) {
                            return null;
                        }
                        argumentEnd = closingQuote;
                        position = closingQuote + 1;
                    } else if (quote === '[') {
                        argumentStart = position + 1;
                        const closingBracket = normalized.value.indexOf(']', argumentStart);
                        if (closingBracket < 0) {
                            return null;
                        }
                        const parameterName = normalized.value.slice(argumentStart, closingBracket);
                        if (!BRACKET_PARAMETER_NAME.test(parameterName)) {
                            return null;
                        }
                        argumentEnd = closingBracket;
                        position = closingBracket + 1;
                    } else {
                        return null;
                    }
                } else {
                    const nextLiteral = foldedLiterals[index + 1];
                    if (nextLiteral) {
                        argumentEnd = normalizedFolded.indexOf(nextLiteral, position);
                        if (argumentEnd < 0) {
                            return null;
                        }
                    } else {
                        argumentEnd = normalized.value.length;
                    }
                    position = argumentEnd;
                }

                if (argumentEnd <= argumentStart) {
                    return null;
                }
                const range = originalRange(normalized, argumentStart, argumentEnd);
                argumentsFound.push({
                    parameter: placeholder.parameter,
                    value: invocation.slice(range.start, range.end),
                    start: range.start,
                    end: range.end
                });
            }

            const finalLiteral = foldedLiterals[foldedLiterals.length - 1];
            if (!normalizedFolded.startsWith(finalLiteral, position)) {
                return null;
            }
            position += finalLiteral.length;
            if (position !== normalized.value.length) {
                return null;
            }

            const invocationRange = normalized.value.length > 0
                ? originalRange(normalized, 0, normalized.value.length)
                : { start: bodyRange.start, end: bodyRange.start };
            return {
                definition,
                invocationRange,
                arguments: Object.freeze(argumentsFound)
            };
        }
    };
}

function compareMatches(left: ProjectDefinitionMatch, right: ProjectDefinitionMatch): number {
    return left.definition.kind.localeCompare(right.definition.kind)
        || left.definition.sourceLabel.localeCompare(right.definition.sourceLabel, undefined, { sensitivity: 'base' })
        || left.definition.id.localeCompare(right.definition.id);
}

export function resolveProjectInvocation(
    view: ProjectDefinitionView,
    invocation: string
): ProjectDefinitionResolution {
    let matchers = compiledViews.get(view);
    if (!matchers) {
        matchers = Object.freeze(view.all.map(compileProjectDefinitionMatcher));
        compiledViews.set(view, matchers);
    }

    const matches = matchers
        .map(matcher => matcher.match(invocation))
        .filter((match): match is ProjectDefinitionMatch => match !== null)
        .sort(compareMatches);

    if (matches.length === 0) {
        return { kind: 'missing', invocation };
    }
    if (matches.length === 1) {
        return { kind: 'unique', match: matches[0] };
    }
    return { kind: 'ambiguous', matches: Object.freeze(matches) };
}
