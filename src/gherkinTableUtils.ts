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

export function alignGherkinTablesInText(scriptText: string, eol: string): string {
    const lines = scriptText.split(/\r\n|\r|\n/);
    let changed = false;

    let index = 0;
    while (index < lines.length) {
        const firstMatch = lines[index].match(GHERKIN_TABLE_ROW_REGEX);
        if (!firstMatch) {
            index++;
            continue;
        }

        const expectedIndent = getExpectedTableIndent(lines, index);
        const tableRows: { lineIndex: number; cells: string[] }[] = [];
        let rowIndex = index;

        while (rowIndex < lines.length) {
            const rowMatch = lines[rowIndex].match(GHERKIN_TABLE_ROW_REGEX);
            if (!rowMatch) {
                break;
            }

            const cells = rowMatch[2].split('|').map(cell => cell.trim());
            tableRows.push({
                lineIndex: rowIndex,
                cells
            });
            rowIndex++;
        }

        if (tableRows.length > 0) {
            const maxColumns = Math.max(...tableRows.map(row => row.cells.length));
            const columnWidths = Array.from({ length: maxColumns }, () => 0);

            for (const row of tableRows) {
                for (let columnIndex = 0; columnIndex < maxColumns; columnIndex++) {
                    const cellValue = row.cells[columnIndex] || '';
                    columnWidths[columnIndex] = Math.max(columnWidths[columnIndex], cellValue.length);
                }
            }

            for (const row of tableRows) {
                const paddedCells: string[] = [];
                for (let columnIndex = 0; columnIndex < maxColumns; columnIndex++) {
                    const value = row.cells[columnIndex] || '';
                    paddedCells.push(value.padEnd(columnWidths[columnIndex], ' '));
                }

                const alignedRow = `${expectedIndent}| ${paddedCells.join(' | ')} |`;
                if (lines[row.lineIndex] !== alignedRow) {
                    lines[row.lineIndex] = alignedRow;
                    changed = true;
                }
            }
        }

        index = rowIndex;
    }

    if (!changed) {
        return scriptText;
    }

    return lines.join(eol);
}
