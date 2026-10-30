const GHERKIN_TABLE_ROW_REGEX = /^([ \t]*)\|(.*)\|\s*$/;
const DEFAULT_GHERKIN_CONTINUATION_INDENT = '    ';

function getLeadingWhitespace(line: string): string {
    return line.match(/^[ \t]*/)?.[0] ?? '';
}

function getVisualIndentWidth(whitespace: string): number {
    let width = 0;
    for (const char of whitespace) {
        if (char === '\t') {
            width += 4;
        } else {
            width += 1;
        }
    }
    return width;
}

function stripLeadingVisualIndent(line: string, targetWidth: number): string {
    if (targetWidth <= 0) {
        return line;
    }

    let visualWidth = 0;
    let index = 0;
    while (index < line.length && visualWidth < targetWidth) {
        const char = line[index];
        if (char === ' ') {
            visualWidth += 1;
            index++;
            continue;
        }

        if (char === '\t') {
            visualWidth += 4;
            index++;
            continue;
        }

        break;
    }

    return line.slice(index);
}

function getCommonContinuationIndentWidth(lines: string[]): number {
    const nonEmptyLines = lines.filter(line => line.trim().length > 0);
    if (nonEmptyLines.length === 0) {
        return 0;
    }

    return Math.min(
        ...nonEmptyLines.map(line => getVisualIndentWidth(getLeadingWhitespace(line)))
    );
}

function getExpectedTableIndent(lines: string[], tableStartLineIndex: number): string {
    for (let index = tableStartLineIndex - 1; index >= 0; index--) {
        const previousLine = lines[index];
        if (previousLine.trim().length === 0) {
            continue;
        }

        return `${getLeadingWhitespace(previousLine)}${DEFAULT_GHERKIN_CONTINUATION_INDENT}`;
    }

    const currentIndent = lines[tableStartLineIndex].match(GHERKIN_TABLE_ROW_REGEX)?.[1];
    return currentIndent ?? '';
}

export function normalizeMultilineStepInsertText(
    stepText: string,
    continuationIndent: string = DEFAULT_GHERKIN_CONTINUATION_INDENT
): string {
    const normalized = stepText.replace(/\r\n|\r/g, '\n');
    const lines = normalized.split('\n');
    if (lines.length <= 1) {
        return normalized;
    }

    const firstLine = lines[0].replace(/[ \t]+$/g, '');
    const continuationLines = lines.slice(1);
    const commonIndentWidth = getCommonContinuationIndentWidth(continuationLines);

    const rebasedLines = continuationLines.map(rawLine => {
        const line = rawLine.replace(/[ \t]+$/g, '');
        if (line.trim().length === 0) {
            return '';
        }

        const relativeLine = stripLeadingVisualIndent(line, commonIndentWidth);
        return `${continuationIndent}${relativeLine}`;
    });

    return [firstLine, ...rebasedLines].join('\n');
}

interface GherkinTableRow {
    lineIndex: number;
    separators: number[];
    cells: string[];
}

function parseTableRow(line: string, lineIndex: number): GherkinTableRow | undefined {
    if (!/^[ \t]*\|/u.test(line)) { return undefined; }
    const separators: number[] = [];
    let escaped = false;
    for (let index = 0; index < line.length; index++) {
        const character = line[index];
        if (character === '|' && !escaped) { separators.push(index); }
        escaped = character === '\\' ? !escaped : false;
    }
    if (separators.length < 2 || separators.at(-1) !== line.trimEnd().length - 1) { return undefined; }
    return {
        lineIndex, separators,
        cells: separators.slice(0, -1).map((offset, index) => line.slice(offset + 1, separators[index + 1]).trim())
    };
}

/** Incomplete and ragged blocks stay intact while a table is being edited. */
function* completeTableBlocks(lines: readonly string[]): Generator<GherkinTableRow[]> {
    let index = 0;
    let docstring: string | undefined;
    let blockComment = false;
    while (index < lines.length) {
        const trimmed = lines[index].trim();
        if (docstring) { if (trimmed === docstring) { docstring = undefined; } index++; continue; }
        if (blockComment) { if (trimmed.includes('*/')) { blockComment = false; } index++; continue; }
        const delimiter = /^("""|'''|```)/u.exec(trimmed);
        if (delimiter) { docstring = delimiter[1]; index++; continue; }
        if (trimmed.startsWith('/*')) { blockComment = !trimmed.includes('*/'); index++; continue; }
        if (!/^[ \t]*\|/u.test(lines[index])) { index++; continue; }
        const rows: GherkinTableRow[] = [];
        let complete = true;
        while (index < lines.length && /^[ \t]*\|/u.test(lines[index])) {
            const row = parseTableRow(lines[index], index);
            if (row) { rows.push(row); } else { complete = false; }
            index++;
        }
        if (complete && rows.length > 0 && rows.every(row => row.cells.length === rows[0].cells.length)) {
            yield rows;
        }
    }
}

export interface GherkinTableDeletion {
    start: number;
    end: number;
}

/** Returns data-cell deletions in the previous text, before the user's header deletion. */
export function planGherkinHeaderColumnDeletion(
    text: string,
    deletion: { offset: number; length: number }
): GherkinTableDeletion[] {
    const { offset, length } = deletion;
    if (length <= 0 || offset < 0 || offset + length > text.length || /[\r\n]/u.test(text.slice(offset, offset + length))) {
        return [];
    }
    const lines = text.split(/\r\n|\r|\n/u);
    const lineOffsets = [0, ...Array.from(text.matchAll(/\r\n|\r|\n/gu), match => match.index! + match[0].length)];
    for (const rows of completeTableBlocks(lines)) {
        const header = rows[0];
        const headerOffset = lineOffsets[header.lineIndex];
        const start = offset - headerOffset;
        const end = start + length;
        if (rows.length < 2 || header.cells.length < 2 || start < 0 || end > lines[header.lineIndex].length) { continue; }
        if (header.separators.filter(pipe => pipe >= start && pipe < end).length !== 1) { return []; }
        if (start < header.separators[0] || end > header.separators.at(-1)! + 1) { return []; }
        const after = parseTableRow(lines[header.lineIndex].slice(0, start) + lines[header.lineIndex].slice(end), header.lineIndex);
        if (!after || after.cells.length !== header.cells.length - 1) { return []; }

        const candidates: number[] = [];
        for (let column = 0; column < header.cells.length; column++) {
            const left = header.separators[column];
            const right = header.separators[column + 1];
            if (!(left >= start && left < end) && !(right >= start && right < end)) { continue; }
            const rawCell = lines[header.lineIndex].slice(left + 1, right);
            const contentStart = left + 1 + (rawCell.match(/^[ \t]*/u)?.[0].length ?? 0);
            const contentEnd = right - (rawCell.match(/[ \t]*$/u)?.[0].length ?? 0);
            const removesContent = rawCell.trim()
                ? start <= contentStart && end >= contentEnd
                : start <= left + 1 && end >= right;
            if (removesContent && after.cells.every((cell, index) => cell === header.cells[index < column ? index : index + 1])) {
                candidates.push(column);
            }
        }
        if (candidates.length !== 1) { return []; }
        const column = candidates[0];
        return rows.slice(1).map(row => ({
            start: lineOffsets[row.lineIndex] + row.separators[column],
            end: lineOffsets[row.lineIndex] + row.separators[column + 1]
        }));
    }
    return [];
}

export function alignGherkinTablesInText(scriptText: string, eol: string): string {
    const lines = scriptText.split(/\r\n|\r|\n/);
    let changed = false;
    for (const tableRows of completeTableBlocks(lines)) {
        const expectedIndent = getExpectedTableIndent(lines, tableRows[0].lineIndex);
        const columnWidths = tableRows[0].cells.map((_cell, column) =>
            Math.max(...tableRows.map(row => row.cells[column].length)));
        for (const row of tableRows) {
            const paddedCells = row.cells.map((value, column) => value.padEnd(columnWidths[column], ' '));
            const alignedRow = `${expectedIndent}| ${paddedCells.join(' | ')} |`;
            if (lines[row.lineIndex] !== alignedRow) {
                lines[row.lineIndex] = alignedRow;
                changed = true;
            }
        }
    }
    return changed ? lines.join(eol) : scriptText;
}
