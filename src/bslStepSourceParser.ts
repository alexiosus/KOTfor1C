import {
    createLocalDefinitionId,
    normalizeProjectDefinitionTemplate,
    type ProjectDefinition,
    type ProjectDefinitionParameter,
    type ProjectDefinitionPosition,
    type ProjectDefinitionRange,
    type ProjectDefinitionWarning
} from './projectDefinition';

export type BslTokenKind = 'identifier' | 'string' | 'punctuation' | 'newline' | 'comment';

export interface BslToken {
    readonly kind: BslTokenKind;
    readonly text: string;
    readonly value?: string;
    readonly startOffset: number;
    readonly endOffset: number;
    readonly range: ProjectDefinitionRange;
    readonly terminated?: boolean;
}

export interface BslDeclaration {
    readonly kind: 'function' | 'procedure';
    readonly name: string;
    readonly nameRange: ProjectDefinitionRange;
    readonly declarationRange: ProjectDefinitionRange;
    readonly bodyRange: ProjectDefinitionRange;
    readonly terminated: boolean;
}

export interface UserStepSourceParseContext {
    readonly sourceUri: string;
    readonly workspaceFolderUri: string;
    readonly profileId: string;
    readonly libraryRootUri: string;
    readonly sourceLabel: string;
}

export interface UserStepSourceParseResult {
    readonly definitions: readonly ProjectDefinition[];
    readonly warnings: readonly ProjectDefinitionWarning[];
    readonly declarations: readonly BslDeclaration[];
    readonly registrationInsertionRange: ProjectDefinitionRange | null;
    readonly moduleAppendRange: ProjectDefinitionRange | null;
}

interface InternalDeclaration extends BslDeclaration {
    readonly startOffset: number;
    readonly endOffset: number;
    readonly bodyStartOffset: number;
    readonly bodyEndOffset: number;
}

const FUNCTION_STARTS = new Map([
    ['функция', { kind: 'function' as const, end: 'конецфункции' }],
    ['function', { kind: 'function' as const, end: 'endfunction' }],
    ['процедура', { kind: 'procedure' as const, end: 'конецпроцедуры' }],
    ['procedure', { kind: 'procedure' as const, end: 'endprocedure' }]
]);
const REGISTRATION_METHOD = 'добавитьшагвмассивтестов';
const REGISTRATION_FUNCTION = 'получитьсписоктестов';
const RETURN_KEYWORDS = new Set(['возврат', 'return']);

function position(line: number, character: number): ProjectDefinitionPosition {
    return Object.freeze({ line, character });
}

function range(start: ProjectDefinitionPosition, end: ProjectDefinitionPosition): ProjectDefinitionRange {
    return Object.freeze({ start, end });
}

function offsetPosition(source: string, target: number): ProjectDefinitionPosition {
    let line = 0;
    let character = 0;
    const limit = Math.min(Math.max(target, 0), source.length);
    for (let index = 0; index < limit; index++) {
        if (source[index] === '\r') {
            if (source[index + 1] === '\n') {
                index += 1;
            }
            line += 1;
            character = 0;
        } else if (source[index] === '\n') {
            line += 1;
            character = 0;
        } else {
            character += 1;
        }
    }
    return position(line, character);
}

function lineStartOffset(source: string, offset: number): number {
    let cursor = Math.min(Math.max(offset, 0), source.length);
    while (cursor > 0 && source[cursor - 1] !== '\n' && source[cursor - 1] !== '\r') {
        cursor -= 1;
    }
    return cursor;
}

function tokenRange(
    startLine: number,
    startCharacter: number,
    endLine: number,
    endCharacter: number
): ProjectDefinitionRange {
    return range(position(startLine, startCharacter), position(endLine, endCharacter));
}

function isIdentifierStart(value: string): boolean {
    return /[\p{L}_]/u.test(value);
}

function isIdentifierPart(value: string): boolean {
    return /[\p{L}\p{N}_]/u.test(value);
}

export function scanBslTokens(source: string): readonly BslToken[] {
    const tokens: BslToken[] = [];
    let index = 0;
    let line = 0;
    let character = 0;

    const push = (
        kind: BslTokenKind,
        startOffset: number,
        startLine: number,
        startCharacter: number,
        value?: string,
        terminated?: boolean
    ): void => {
        tokens.push(Object.freeze({
            kind,
            text: source.slice(startOffset, index),
            value,
            startOffset,
            endOffset: index,
            range: tokenRange(startLine, startCharacter, line, character),
            terminated
        }));
    };

    while (index < source.length) {
        const current = source[index];
        if (current === '\uFEFF' || (current !== '\r' && current !== '\n' && /\s/u.test(current))) {
            index += 1;
            character += 1;
            continue;
        }

        const startOffset = index;
        const startLine = line;
        const startCharacter = character;
        if (current === '\r' || current === '\n') {
            if (current === '\r' && source[index + 1] === '\n') {
                index += 2;
            } else {
                index += 1;
            }
            line += 1;
            character = 0;
            push('newline', startOffset, startLine, startCharacter);
            continue;
        }

        if (current === '/' && source[index + 1] === '/') {
            index += 2;
            character += 2;
            while (index < source.length && source[index] !== '\r' && source[index] !== '\n') {
                index += 1;
                character += 1;
            }
            push('comment', startOffset, startLine, startCharacter);
            continue;
        }

        if (current === '"') {
            let value = '';
            let terminated = false;
            index += 1;
            character += 1;
            while (index < source.length) {
                if (source[index] === '"') {
                    if (source[index + 1] === '"') {
                        value += '"';
                        index += 2;
                        character += 2;
                        continue;
                    }
                    index += 1;
                    character += 1;
                    terminated = true;
                    break;
                }
                if (source[index] === '\r' || source[index] === '\n') {
                    if (source[index] === '\r' && source[index + 1] === '\n') {
                        index += 2;
                    } else {
                        index += 1;
                    }
                    value += '\n';
                    line += 1;
                    character = 0;
                    continue;
                }
                value += source[index];
                index += 1;
                character += 1;
            }
            push('string', startOffset, startLine, startCharacter, value, terminated);
            continue;
        }

        if (isIdentifierStart(current)) {
            index += 1;
            character += 1;
            while (index < source.length && isIdentifierPart(source[index])) {
                index += 1;
                character += 1;
            }
            push('identifier', startOffset, startLine, startCharacter);
            continue;
        }

        index += 1;
        character += 1;
        push('punctuation', startOffset, startLine, startCharacter);
    }

    return Object.freeze(tokens);
}

function folded(value: string): string {
    return value.toLocaleLowerCase();
}

function significantTokens(tokens: readonly BslToken[]): BslToken[] {
    return tokens.filter(token => token.kind !== 'comment' && token.kind !== 'newline');
}

function findLineEnd(source: string, offset: number): number {
    for (let index = offset; index < source.length; index++) {
        if (source[index] === '\r' || source[index] === '\n') {
            return index;
        }
    }
    return source.length;
}

function afterLineEnd(source: string, offset: number): number {
    let index = findLineEnd(source, offset);
    if (source[index] === '\r' && source[index + 1] === '\n') {
        return index + 2;
    }
    if (source[index] === '\r' || source[index] === '\n') {
        return index + 1;
    }
    return index;
}

function parseDeclarations(
    source: string,
    tokens: readonly BslToken[],
    warnings: ProjectDefinitionWarning[],
    uri: string
): InternalDeclaration[] {
    const declarations: InternalDeclaration[] = [];
    for (let index = 0; index < tokens.length; index++) {
        const token = tokens[index];
        if (token.kind !== 'identifier') {
            continue;
        }
        const start = FUNCTION_STARTS.get(folded(token.text));
        if (!start) {
            continue;
        }
        const nameToken = tokens.slice(index + 1).find(candidate => candidate.kind === 'identifier');
        if (!nameToken) {
            warnings.push({ uri, message: 'BSL declaration has no static name.', range: token.range });
            continue;
        }

        let endToken: BslToken | undefined;
        let endIndex = index + 1;
        for (; endIndex < tokens.length; endIndex++) {
            const candidate = tokens[endIndex];
            if (candidate.kind !== 'identifier') {
                continue;
            }
            if (folded(candidate.text) === start.end) {
                endToken = candidate;
                break;
            }
            if (FUNCTION_STARTS.has(folded(candidate.text))) {
                break;
            }
        }

        const bodyStartOffset = afterLineEnd(source, nameToken.endOffset);
        const bodyEndOffset = endToken?.startOffset ?? source.length;
        const endOffset = endToken?.endOffset ?? source.length;
        const declaration: InternalDeclaration = Object.freeze({
            kind: start.kind,
            name: nameToken.text,
            nameRange: nameToken.range,
            declarationRange: range(token.range.start, offsetPosition(source, endOffset)),
            bodyRange: range(offsetPosition(source, bodyStartOffset), offsetPosition(source, bodyEndOffset)),
            terminated: Boolean(endToken),
            startOffset: token.startOffset,
            endOffset,
            bodyStartOffset,
            bodyEndOffset
        });
        declarations.push(declaration);
        if (!endToken) {
            warnings.push({
                uri,
                message: `Unterminated BSL ${start.kind} declaration: ${nameToken.text}.`,
                range: range(token.range.start, nameToken.range.end)
            });
        } else {
            index = endIndex;
        }
    }
    return declarations;
}

function evaluateStaticExpression(
    tokens: readonly BslToken[],
    variables: ReadonlyMap<string, string>
): string | null {
    let index = 0;

    const primary = (): string | null => {
        const token = tokens[index];
        if (!token) {
            return null;
        }
        if (token.kind === 'string' && token.terminated !== false) {
            index += 1;
            return token.value ?? '';
        }
        if (token.kind === 'identifier') {
            index += 1;
            return variables.get(folded(token.text)) ?? null;
        }
        if (token.text === '(') {
            index += 1;
            const value = expression();
            if (value === null || tokens[index]?.text !== ')') {
                return null;
            }
            index += 1;
            return value;
        }
        return null;
    };

    const expression = (): string | null => {
        let value = primary();
        if (value === null) {
            return null;
        }
        while (tokens[index]?.text === '+') {
            index += 1;
            const right = primary();
            if (right === null) {
                return null;
            }
            value += right;
        }
        return value;
    };

    const value = expression();
    return value !== null && index === tokens.length ? value : null;
}

function collectStaticVariables(
    tokens: readonly BslToken[],
    startOffset: number,
    endOffset: number
): ReadonlyMap<string, string> {
    const variables = new Map<string, string>();
    const scoped = significantTokens(tokens).filter(token =>
        token.startOffset >= startOffset && token.endOffset <= endOffset
    );
    let statementStart = 0;
    for (let index = 0; index <= scoped.length; index++) {
        if (index < scoped.length && scoped[index].text !== ';') {
            continue;
        }
        const statement = scoped.slice(statementStart, index);
        statementStart = index + 1;
        if (statement[0]?.kind !== 'identifier' || statement[1]?.text !== '=') {
            continue;
        }
        const name = folded(statement[0].text);
        const value = evaluateStaticExpression(statement.slice(2), variables);
        if (value === null) {
            variables.delete(name);
        } else {
            variables.set(name, value);
        }
    }
    return variables;
}

const PAIRS = new Map([['(', ')'], ['[', ']'], ['{', '}']]);
const CLOSING = new Set(PAIRS.values());

function findClosingToken(tokens: readonly BslToken[], openIndex: number): number {
    const stack: string[] = [];
    for (let index = openIndex; index < tokens.length; index++) {
        const text = tokens[index].text;
        const close = PAIRS.get(text);
        if (close) {
            stack.push(close);
            continue;
        }
        if (!CLOSING.has(text) || stack.pop() !== text) {
            if (CLOSING.has(text)) {
                return -1;
            }
            continue;
        }
        if (stack.length === 0) {
            return index;
        }
    }
    return -1;
}

function splitArguments(tokens: readonly BslToken[]): readonly BslToken[][] | null {
    const result: BslToken[][] = [];
    let current: BslToken[] = [];
    const stack: string[] = [];
    for (const token of tokens) {
        const close = PAIRS.get(token.text);
        if (close) {
            stack.push(close);
            current.push(token);
            continue;
        }
        if (CLOSING.has(token.text)) {
            if (stack.pop() !== token.text) {
                return null;
            }
            current.push(token);
            continue;
        }
        if (token.text === ',' && stack.length === 0) {
            result.push(current);
            current = [];
            continue;
        }
        current.push(token);
    }
    if (stack.length > 0) {
        return null;
    }
    result.push(current);
    return result;
}

function extractSnippetParameters(snippet: string): string[] {
    const open = snippet.indexOf('(');
    const close = snippet.lastIndexOf(')');
    if (open < 0 || close <= open) {
        return [];
    }
    return snippet
        .slice(open + 1, close)
        .split(',')
        .map(value => value
            .replace(/^\s*(?:знач|val)\s+/iu, '')
            .split('=')[0]
            .trim())
        .filter(Boolean);
}

function extractTemplateParameterHints(template: string): string[] {
    const result: string[] = [];
    for (let index = 0; index < template.length; index++) {
        const quote = template[index];
        if (quote !== '"' && quote !== "'") {
            continue;
        }
        const end = template.indexOf(quote, index + 1);
        if (end < 0) {
            break;
        }
        result.push(template.slice(index + 1, end).trim());
        index = end;
    }
    return result;
}

function createParameters(snippet: string, template: string): readonly ProjectDefinitionParameter[] {
    const snippetNames = extractSnippetParameters(snippet);
    const hints = extractTemplateParameterHints(template);
    return Object.freeze(hints.map((hint, index) => Object.freeze({
        name: snippetNames[index] || hint || `Parameter${index + 1}`,
        index,
        source: 'snippet' as const
    })));
}

function callStartToken(tokens: readonly BslToken[], methodIndex: number): BslToken {
    let start = methodIndex;
    while (
        start >= 2
        && tokens[start - 1].text === '.'
        && tokens[start - 2].kind === 'identifier'
    ) {
        start -= 2;
    }
    return tokens[start];
}

function findContainingDeclaration(
    declarations: readonly InternalDeclaration[],
    offset: number
): InternalDeclaration | undefined {
    return declarations.find(item => offset >= item.bodyStartOffset && offset < item.bodyEndOffset);
}

function moduleDelimitersAreBalanced(tokens: readonly BslToken[]): boolean {
    const stack: string[] = [];
    for (const token of significantTokens(tokens)) {
        const close = PAIRS.get(token.text);
        if (close) {
            stack.push(close);
        } else if (CLOSING.has(token.text) && stack.pop() !== token.text) {
            return false;
        }
    }
    return stack.length === 0;
}

function registrationInsertion(
    source: string,
    tokens: readonly BslToken[],
    declarations: readonly InternalDeclaration[],
    warnings: ProjectDefinitionWarning[],
    uri: string
): ProjectDefinitionRange | null {
    const candidates = declarations.filter(item => folded(item.name) === REGISTRATION_FUNCTION);
    if (candidates.length !== 1) {
        if (candidates.length > 1) {
            warnings.push({
                uri,
                message: 'Ambiguous BSL registration insertion: several ПолучитьСписокТестов declarations were found.'
            });
        }
        return null;
    }
    const declaration = candidates[0];
    if (!declaration.terminated) {
        return null;
    }
    const returnToken = significantTokens(tokens).find(token =>
        token.startOffset >= declaration.bodyStartOffset
        && token.endOffset <= declaration.bodyEndOffset
        && token.kind === 'identifier'
        && RETURN_KEYWORDS.has(folded(token.text))
    );
    const insertionOffset = lineStartOffset(source, returnToken?.startOffset ?? declaration.bodyEndOffset);
    const insertionPosition = offsetPosition(source, insertionOffset);
    return range(insertionPosition, insertionPosition);
}

export function parseUserStepSource(
    source: string,
    context: UserStepSourceParseContext
): UserStepSourceParseResult {
    const tokens = scanBslTokens(source);
    const warnings: ProjectDefinitionWarning[] = [];
    const declarations = parseDeclarations(source, tokens, warnings, context.sourceUri);
    const significant = significantTokens(tokens);
    const definitions: ProjectDefinition[] = [];

    for (let index = 0; index < significant.length; index++) {
        const method = significant[index];
        if (
            method.kind !== 'identifier'
            || folded(method.text) !== REGISTRATION_METHOD
            || significant[index + 1]?.text !== '('
        ) {
            continue;
        }
        const closeIndex = findClosingToken(significant, index + 1);
        const startToken = callStartToken(significant, index);
        const callEnd = closeIndex >= 0 ? significant[closeIndex] : method;
        const callRange = range(startToken.range.start, callEnd.range.end);
        if (closeIndex < 0) {
            warnings.push({
                uri: context.sourceUri,
                message: 'Unterminated user-step registration call.',
                range: callRange
            });
            continue;
        }
        const args = splitArguments(significant.slice(index + 2, closeIndex));
        if (!args || args.length < 5) {
            warnings.push({
                uri: context.sourceUri,
                message: 'Unsupported user-step registration argument list.',
                range: callRange
            });
            index = closeIndex;
            continue;
        }

        const owner = findContainingDeclaration(declarations, method.startOffset);
        const scopeStart = owner?.bodyStartOffset ?? 0;
        const variables = collectStaticVariables(tokens, scopeStart, method.startOffset);
        const snippet = evaluateStaticExpression(args[1], variables);
        const implementationName = evaluateStaticExpression(args[2], variables);
        const template = evaluateStaticExpression(args[3], variables);
        const description = evaluateStaticExpression(args[4], variables);
        const category = args[5] ? evaluateStaticExpression(args[5], variables) : '';
        if (
            snippet === null
            || implementationName === null
            || template === null
            || description === null
            || category === null
        ) {
            warnings.push({
                uri: context.sourceUri,
                message: 'User-step registration contains a dynamic expression and was skipped.',
                range: callRange
            });
            index = closeIndex;
            continue;
        }
        if (!template.trim()) {
            warnings.push({
                uri: context.sourceUri,
                message: 'User-step registration has an empty display template.',
                range: callRange
            });
            index = closeIndex;
            continue;
        }

        const definitionLocation = Object.freeze({ uri: context.sourceUri, range: callRange });
        const implementation = declarations.filter(item => folded(item.name) === folded(implementationName));
        const implementationLocation = implementation.length === 1
            ? Object.freeze({ uri: context.sourceUri, range: implementation[0].nameRange })
            : definitionLocation;
        const id = createLocalDefinitionId({
            kind: 'userStep',
            sourceUri: context.sourceUri,
            range: callRange,
            signature: template
        });
        definitions.push(Object.freeze({
            id,
            kind: 'userStep',
            template,
            normalizedTemplate: normalizeProjectDefinitionTemplate(template),
            parameters: createParameters(snippet, template),
            description: description || undefined,
            category: category || undefined,
            sourceLabel: context.sourceLabel,
            workspaceFolderUri: context.workspaceFolderUri,
            profileId: context.profileId,
            libraryRootUri: context.libraryRootUri,
            definitionLocation,
            implementationLocation
        }));
        index = closeIndex;
    }

    const malformedString = tokens.find(token => token.kind === 'string' && token.terminated === false);
    const balanced = moduleDelimitersAreBalanced(tokens);
    if (malformedString) {
        warnings.push({
            uri: context.sourceUri,
            message: 'Unterminated BSL string literal prevents safe module insertion.',
            range: malformedString.range
        });
    }
    if (!balanced) {
        warnings.push({ uri: context.sourceUri, message: 'Unbalanced BSL delimiters prevent safe module insertion.' });
    }
    const moduleSafe = declarations.every(item => item.terminated) && !malformedString && balanced;
    const modulePosition = offsetPosition(source, source.length);
    const registrationInsertionRange = registrationInsertion(
        source,
        tokens,
        declarations,
        warnings,
        context.sourceUri
    );

    return Object.freeze({
        definitions: Object.freeze(definitions),
        warnings: Object.freeze(warnings),
        declarations: Object.freeze(declarations),
        registrationInsertionRange,
        moduleAppendRange: moduleSafe ? range(modulePosition, modulePosition) : null
    });
}
