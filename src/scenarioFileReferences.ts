import path from 'node:path';
import { getCompilerScenarioBody, scanCompilerLines } from './scenarioCompilerSyntax';

export interface ScenarioFileReference { text: string; line: number; start: number; end: number }

export function normalizeFileReference(value: string): string | undefined {
    let text = value.trim();
    if (/^(["']).*\1$/u.test(text)) { text = text.slice(1, -1); }
    if (!text || text.length > 4096 || /[\r\n\0$<>]|^[a-z][a-z\d+.-]*:\/\//iu.test(text)) { return; }
    return text.normalize('NFC').replace(/\\/gu, '/').replace(/^\.\//u, '');
}

export function fileReferenceAliases(value: string, caseInsensitive = process.platform === 'win32'): string[] {
    const normalized = normalizeFileReference(value);
    if (!normalized) { return []; }
    const full = caseInsensitive ? normalized.toLowerCase() : normalized;
    const name = path.posix.basename(full);
    const extension = path.posix.extname(name);
    const stem = extension ? name.slice(0, -extension.length) : name;
    const unqualified = extension && !/\.[\p{L}][\p{L}\d_-]{0,15}$/u.test(stem);
    return [...new Set([full, name, ...(unqualified ? [full.slice(0, -extension.length), stem] : [])])];
}

/** Preserve source ranges, including filenames with spaces, Cyrillic and dotted names. */
export function fileReferencesOnLine(text: string, line = 0): ScenarioFileReference[] {
    const references: ScenarioFileReference[] = [];
    const add = (start: number, end: number) => {
        const raw = text.slice(start, end); const leading = raw.length - raw.trimStart().length;
        start += leading; end -= raw.length - raw.trimEnd().length;
        const value = text.slice(start, end);
        if (normalizeFileReference(value)) { references.push({ text: value, line, start, end }); }
    };
    for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/gu)) { add(match.index! + 1, match.index! + match[0].length - 1); }
    if (/^\s*\|/u.test(text)) {
        for (const match of text.matchAll(/\|((?:\\.|[^|\\])*)(?=\|)/gu)) {
            const start = match.index! + 1; const end = start + match[1].length;
            if (!references.some(ref => ref.start >= start && ref.end <= end)) { add(start, end); }
        }
    }
    for (const match of text.matchAll(/[^\s"'|=(),;]+\.[\p{L}][\p{L}\d_-]{0,15}/gu)) {
        const start = match.index!; const end = start + match[0].length;
        if (!references.some(ref => start >= ref.start && end <= ref.end)) { add(start, end); }
    }
    return references.sort((a, b) => a.start - b.start);
}

export function collectScenarioFileReferences(source: string, yaml: boolean): ScenarioFileReference[] {
    const body = yaml ? getCompilerScenarioBody(source) : { startLine: 0, lines: source.split(/\r\n|\r|\n/u) };
    if (!body) { return []; }
    const scanned = scanCompilerLines(body.lines);
    return body.lines.flatMap((line, index) => ['code', 'table'].includes(scanned[index].kind)
        ? fileReferencesOnLine(line, body.startLine + index) : []);
}

/** A path reference must retain its directory; an explicit extension must retain its type. */
export function matchesFileReference(reference: string, relativePath: string): boolean {
    const value = normalizeFileReference(reference); if (!value) { return false; }
    const aliases = fileReferenceAliases(relativePath);
    const key = process.platform === 'win32' ? value.toLowerCase() : value;
    return aliases.includes(key) || key.startsWith('files/') && aliases.includes(key.slice(6));
}
