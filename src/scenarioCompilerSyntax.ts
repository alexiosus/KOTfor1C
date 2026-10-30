import { ScenarioYamlDocument } from './scenarioYamlDocument';

/** Syntax owned by СборкаТекстовСценариев, rather than by Vanessa's step catalog. */
export interface CompilerBlock {
    family: 'if' | 'loop' | 'try';
    dialect: 'en' | 'ru' | 'preprocessor';
    phase: 'open' | 'branch' | 'close';
    terminalBranch?: boolean;
    expression?: string;
}

export interface CompilerLine {
    kind: 'code' | 'comment' | 'docString' | 'table';
    block: CompilerBlock | null;
}

export interface CompilerIssue {
    line: number;
    kind: 'unclosed' | 'order' | 'expression' | 'comment' | 'docString' | 'binding';
    family?: CompilerBlock['family'];
}

export function compilerBlock(text: string): CompilerBlock | null {
    const value = text.trim();
    const condition = /^(#Если|#ИначеЕсли|Если|ИначеЕсли|If|ElseIf)\s+(.+)\s+(Тогда|Then)$/iu.exec(value);
    if (condition) {
        const keyword = condition[1].toLowerCase();
        const dialect = keyword.startsWith('#') ? 'preprocessor' : /^(?:if|elseif)$/u.test(keyword) ? 'en' : 'ru';
        if ((dialect === 'en') !== (condition[3].toLowerCase() === 'then')) { return null; }
        return { family: 'if', dialect, phase: /иначе|else/iu.test(keyword) ? 'branch' : 'open', expression: condition[2] };
    }
    const keyword = value.split(/\s+/u, 1)[0].toLowerCase();
    const tokens: Record<string, CompilerBlock> = {
        do: { family: 'loop', dialect: 'en', phase: 'open' },
        цикл: { family: 'loop', dialect: 'ru', phase: 'open' },
        enddo: { family: 'loop', dialect: 'en', phase: 'close' },
        конеццикла: { family: 'loop', dialect: 'ru', phase: 'close' },
        try: { family: 'try', dialect: 'en', phase: 'open' },
        попытка: { family: 'try', dialect: 'ru', phase: 'open' },
        except: { family: 'try', dialect: 'en', phase: 'branch', terminalBranch: true },
        исключение: { family: 'try', dialect: 'ru', phase: 'branch', terminalBranch: true },
        endtry: { family: 'try', dialect: 'en', phase: 'close' },
        конецпопытки: { family: 'try', dialect: 'ru', phase: 'close' },
        else: { family: 'if', dialect: 'en', phase: 'branch', terminalBranch: true },
        иначе: { family: 'if', dialect: 'ru', phase: 'branch', terminalBranch: true },
        '#иначе': { family: 'if', dialect: 'preprocessor', phase: 'branch', terminalBranch: true },
        endif: { family: 'if', dialect: 'en', phase: 'close' },
        конецесли: { family: 'if', dialect: 'ru', phase: 'close' },
        '#конецесли': { family: 'if', dialect: 'preprocessor', phase: 'close' }
    };
    return tokens[keyword] ?? null;
}

export function scanCompilerLines(lines: readonly string[]): CompilerLine[] {
    let blockComment = false;
    let docString = '';
    return lines.map(text => {
        const value = text.trim();
        const marker = /^("""|```)/u.exec(value)?.[1];
        if (docString) {
            if (marker === docString) { docString = ''; }
            return { kind: 'docString', block: null };
        }
        if (blockComment) {
            if (value.startsWith('*/') || value.endsWith('*/')) { blockComment = false; }
            return { kind: 'comment', block: null };
        }
        if (value.startsWith('/*')) {
            blockComment = !value.endsWith('*/');
            return { kind: 'comment', block: null };
        }
        if (value.startsWith('*/') || value.endsWith('*/')) { return { kind: 'comment', block: null }; }
        if (marker) {
            docString = marker;
            return { kind: 'docString', block: null };
        }
        const block = compilerBlock(text);
        if (value.startsWith('//') || (value.startsWith('#') && !block && !/^#(?:Если|ИначеЕсли)(?:\s|$)/iu.test(value))) {
            return { kind: 'comment', block: null };
        }
        return { kind: value.startsWith('|') ? 'table' : 'code', block };
    });
}

/** Structural checks only; expressions are evaluated by the external 1C compiler. */
export function validPreprocessorExpression(expression: string): boolean {
    let quote = '';
    const stack: string[] = [];
    for (let index = 0; index < expression.length; index++) {
        const char = expression[index];
        if (quote) {
            if (char === '\\') { index++; continue; }
            if (char === quote) {
                if (expression[index + 1] === quote) { index++; } else { quote = ''; }
            }
        } else if (char === '"' || char === "'") { quote = char; }
        else if (char === '(' || char === '[') { stack.push(char); }
        else if (char === ')' || char === ']') {
            if (stack.pop() !== (char === ')' ? '(' : '[')) { return false; }
        }
    }
    return !!expression.trim() && !quote && stack.length === 0 && !/[=<>+*/-]\s*$/u.test(expression);
}

export function validateCompilerBlocks(lines: readonly string[], scanned = scanCompilerLines(lines)): CompilerIssue[] {
    const issues: CompilerIssue[] = [];
    const stack: Array<CompilerBlock & { line: number; branched: boolean }> = [];
    let commentStart = -1;
    let docStringStart = -1;
    let docStringDelimiter = '';
    for (let line = 0; line < lines.length; line++) {
        const value = lines[line].trim();
        const info = scanned[line];
        if (info.kind === 'comment') {
            if (commentStart < 0 && value.startsWith('/*') && !value.endsWith('*/')) { commentStart = line; }
            if (value.startsWith('*/') || value.endsWith('*/')) {
                if (commentStart < 0 && !value.startsWith('/*')) { issues.push({ line, kind: 'order' }); }
                commentStart = -1;
            }
            continue;
        }
        if (info.kind === 'docString') {
            const marker = /^("""|```)/u.exec(value)?.[1];
            if (marker && !docStringDelimiter) { docStringStart = line; docStringDelimiter = marker; }
            else if (marker === docStringDelimiter) { docStringStart = -1; docStringDelimiter = ''; }
            continue;
        }
        if (info.kind !== 'code') { continue; }
        if (/^(?:Return|Возврат)(?:\s|$)/iu.test(value) && !parseCompilerParameterBinding(value)) {
            issues.push({ line, kind: 'binding' });
        }
        const block = info.block;
        if (/^#(?:Если|ИначеЕсли)(?:\s|$)/iu.test(value)
            && (!block?.expression || !validPreprocessorExpression(block.expression))) {
            issues.push({ line, kind: 'expression' });
        }
        if (!block) { continue; }
        if (block.phase === 'open') {
            stack.push({ ...block, line, branched: false });
            continue;
        }
        const opening = stack.at(-1);
        if (!opening || opening.family !== block.family || opening.dialect !== block.dialect
            || (block.phase === 'branch' && opening.branched)) {
            issues.push({ line, kind: 'order', family: block.family });
            continue;
        }
        if (block.phase === 'close') { stack.pop(); }
        else if (block.terminalBranch) { opening.branched = true; }
    }
    stack.forEach(block => issues.push({ line: block.line, kind: 'unclosed', family: block.family }));
    if (commentStart >= 0) { issues.push({ line: commentStart, kind: 'comment' }); }
    if (docStringStart >= 0) { issues.push({ line: docStringStart, kind: 'docString' }); }
    return issues;
}

export interface CompilerParameterBinding {
    name: string;
    value: string;
    kind: 'input' | 'output' | 'return' | 'table';
    alias?: string;
}

export function getCompilerScenarioBody(source: string): { startLine: number; lines: string[] } | null {
    const lines = source.split(/\r\n|\r|\n/u);
    const field = ScenarioYamlDocument.parse(source).findFieldAtPath(['ТекстСценария']);
    if (!field || field.ambiguous || field.valueKind !== 'blockScalar') { return null; }
    const header = source.slice(0, field.lineStart).split(/\r\n|\r|\n/u).length - 1;
    const indent = /^[ \t]*/u.exec(lines[header])![0].length;
    let end = header + 1;
    while (end < lines.length && (!lines[end].trim() || /^[ \t]*/u.exec(lines[end])![0].length > indent)) { end++; }
    return { startLine: header + 1, lines: lines.slice(header + 1, end) };
}

export function findCompilerScenarioCall(lines: readonly string[], line: number): string | null {
    const scanned = scanCompilerLines(lines);
    const indent = /^[ \t]*/u.exec(lines[line] ?? '')![0].length;
    for (let index = line - 1; index >= 0; index--) {
        const text = lines[index];
        if (!text.trim() || scanned[index].kind === 'comment' || scanned[index].kind === 'table') { continue; }
        if (scanned[index].kind !== 'code') { return null; }
        if (parseCompilerParameterBinding(text)) { continue; }
        const call = /^([ \t]*)(?:And|И|Допустим)\s+([^"']+)$/iu.exec(text);
        return call && call[1].length <= indent ? call[2].trim() : null;
    }
    return null;
}

export function parseCompilerParameterBinding(text: string): CompilerParameterBinding | null {
    const returned = /^(Возврат|Return)\s+([\wА-Яа-яЁё-]+)(?:\s+(как|as)\s+([\wА-Яа-яЁё-]+))?\s*$/iu.exec(text.trim());
    if (returned) {
        if (returned[3] && (returned[1].toLowerCase() === 'return') !== (returned[3].toLowerCase() === 'as')) { return null; }
        return { name: returned[2], value: '', kind: 'return', alias: returned[4] };
    }
    const assignment = /^([\wА-Яа-яЁё-]+)\s*=\s*(.*)$/u.exec(text.trim());
    if (!assignment) { return null; }
    const value = assignment[2].trim();
    return { name: assignment[1], value, kind: !value ? 'table' : /["'\[]/u.test(value) ? 'input' : 'output' };
}

/** Includes parameter substitutions; return aliases are literal runtime variable names. */
export function collectCompilerParameterReferences(lines: readonly string[]): string[] {
    return [...new Set(compilerParameterReferenceOccurrences(lines).map(reference => reference.name))];
}

/** The compiler substitutes bracket references in code, tables and docstrings. */
export function compilerParameterReferenceOccurrences(lines: readonly string[]): { line: number; start: number; length: number; name: string }[] {
    const references: { line: number; start: number; length: number; name: string }[] = [];
    const scanned = scanCompilerLines(lines);
    lines.forEach((text, index) => {
        if (scanned[index].kind === 'comment') { return; }
        for (const match of text.matchAll(/(?<!\\)\[([\wА-Яа-яЁё-]+)(?<!\\)\]/gu)) {
            references.push({ line: index, start: match.index!, length: match[0].length, name: match[1] });
        }
    });
    return references;
}
