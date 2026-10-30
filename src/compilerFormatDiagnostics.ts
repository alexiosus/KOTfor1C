import { isMap, isScalar, isSeq, parseDocument, Scalar } from 'yaml';

export type CompilerFormatIssueKind = 'extension' | 'scalar' | 'blockScalar' | 'indentation' | 'comment';

export interface CompilerFormatIssue {
    readonly kind: CompilerFormatIssueKind;
    readonly line: number;
    readonly startCharacter: number;
    readonly endCharacter: number;
}

function commentOffset(text: string): number {
    let quote = '';
    for (let index = 0; index < text.length; index++) {
        const char = text[index];
        if (quote) {
            if (quote === '"' && char === '\\') { index++; }
            else if (char === quote) {
                if (quote === "'" && text[index + 1] === quote) { index++; }
                else { quote = ''; }
            }
        } else if (char === '"' || char === "'") { quote = char; }
        else if (char === '#' && (index === 0 || /\s/u.test(text[index - 1]))) { return index; }
    }
    return -1;
}

/** Warnings about the supplied SPPR reader's subset, rather than general YAML validity.
 * Its file reader uses levels of four spaces, recognizes only an exact | marker,
 * and removes the first and last character of every other nonempty value token.
 * Source is never rewritten, and scalar payload is kept out of structural checks.
 */
export function collectCompilerFormatIssues(source: string, fileName: string): CompilerFormatIssue[] {
    if (!/\.ya?ml$/iu.test(fileName) || /\.kot\.ya?ml$/iu.test(fileName)) { return []; }
    const type = /^\uFEFF?(?:ТипФайла|типфайла):[ \t]*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^#\r\n]*?))[ \t]*(?:#.*)?$/mu.exec(source);
    if (!type || !['сценарий', 'процесс', 'настройкатеста', 'настройкапроцесса'].includes((type[1] ?? type[2] ?? type[3]).trim().toLowerCase())) { return []; }
    const lines = source.split(/\r\n|\r|\n/u);
    const starts = [0, ...Array.from(source.matchAll(/\r\n|\r|\n/gu), match => match.index + match[0].length)];
    const location = (offset: number): { line: number; character: number } => {
        let low = 0; let high = starts.length;
        while (low < high) {
            const middle = Math.floor((low + high) / 2);
            if (starts[middle] <= offset) { low = middle + 1; } else { high = middle; }
        }
        const line = low - 1;
        return { line, character: offset - starts[line] };
    };
    const issues: CompilerFormatIssue[] = [];
    const add = (kind: CompilerFormatIssueKind, offset: number, length: number) => {
        const { line, character } = location(offset);
        issues.push({ kind, line, startCharacter: character, endCharacter: Math.min(lines[line].length, character + Math.max(1, length)) });
    };
    if (/\.yml$/iu.test(fileName)) { add('extension', type.index, type[0].length); }
    const parsed = parseDocument(source, { prettyErrors: false, uniqueKeys: false });
    // Existing YAML diagnostics own malformed syntax, especially indentation tabs.
    if (parsed.errors.length) { return issues; }
    const payloadLines = new Set<number>();
    const protectContinuation = (start: number, end: number) => {
        for (let line = location(start).line + 1; line <= location(Math.max(start, end - 1)).line; line++) { payloadLines.add(line); }
    };
    const inspect = (node: unknown): void => {
        if (isMap(node) || isSeq(node)) {
            if (node.flow && node.range) {
                const { line, character } = location(node.range[0]);
                add('scalar', node.range[0], lines[line].length - character);
                protectContinuation(node.range[0], node.range[1]);
            } else if (isMap(node)) { node.items.forEach(pair => inspect(pair.value)); }
            else { node.items.forEach(inspect); }
            return;
        }
        if (!isScalar(node) || !node.range || node.range[0] === node.range[1]) { return; }
        const start = node.range[0]; const end = node.range[1];
        const { line, character } = location(start);
        const token = source.slice(start, Math.min(end, starts[line] + lines[line].length));
        if (node.type === Scalar.BLOCK_LITERAL || node.type === Scalar.BLOCK_FOLDED) {
            const comment = commentOffset(token);
            const marker = (comment < 0 ? token : token.slice(0, comment)).trim();
            if (marker !== '|') { add('blockScalar', start, marker.length); }
            protectContinuation(start, end);
        } else {
            const raw = source.slice(start, end);
            const quoted = (token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'"));
            if (!quoted || /[\r\n]/u.test(raw)) { add('scalar', start, token.length); }
            if (/[\r\n]/u.test(raw)) { protectContinuation(start, end); }
        }
    };
    inspect(parsed.contents);
    lines.forEach((line, index) => {
        if (payloadLines.has(index) || !line.trim()) { return; }
        const normalized = line.replace(/^\uFEFF/u, '');
        const bomLength = line.length - normalized.length;
        const comment = commentOffset(normalized);
        if (comment >= 0) { add('comment', starts[index] + bomLength + comment, normalized.length - comment); }
        const indentation = /^[ \t]*/u.exec(normalized)![0];
        if (!normalized.trimStart().startsWith('#') && !indentation.includes('\t') && indentation.length % 4 !== 0) {
            add('indentation', starts[index] + bomLength, indentation.length);
        }
    });
    return issues.sort((left, right) => left.line - right.line || left.startCharacter - right.startCharacter);
}
