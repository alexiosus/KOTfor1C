import {
    isMap,
    isNode,
    isPair,
    isScalar,
    isSeq,
    parseDocument,
    type Pair
} from 'yaml';

export interface SourceRange {
    start: number;
    end: number;
}

export interface SourceEdit {
    range: SourceRange;
    text: string;
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

function getNodeRange(value: unknown): readonly [number, number, number] | null {
    if (!isNode(value) || !value.range) {
        return null;
    }

    return value.range;
}

function getPresentNodeRange(value: unknown): readonly [number, number, number] | null {
    const range = getNodeRange(value);
    if (isScalar(value) && value.value === null && range?.[0] === range?.[1]) {
        return null;
    }

    return range;
}

function getScalarKey(value: unknown): string | null {
    if (!isScalar(value) || typeof value.value !== 'string') {
        return null;
    }

    return value.value;
}

function getNodeValue(value: unknown): unknown {
    if (isScalar(value)) {
        return value.value;
    }

    if (isNode(value)) {
        return value.toJSON();
    }

    return value ?? null;
}

function findLineStart(source: string, offset: number): number {
    return source.lastIndexOf('\n', Math.max(0, offset - 1)) + 1;
}

function findLineEnd(source: string, offset: number): number {
    const newlineOffset = source.indexOf('\n', offset);
    const rawEnd = newlineOffset === -1 ? source.length : newlineOffset;
    return rawEnd > 0 && source[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
}

function findLineEndWithNewline(source: string, offset: number): number {
    const newlineOffset = source.indexOf('\n', offset);
    return newlineOffset === -1 ? source.length : newlineOffset + 1;
}

function withoutTrailingLineBreak(source: string, end: number): number {
    if (end >= 2 && source.slice(end - 2, end) === '\r\n') {
        return end - 2;
    }
    if (end >= 1 && source[end - 1] === '\n') {
        return end - 1;
    }
    return end;
}

function pairSourceRange(source: string, pair: Pair): SourceRange | null {
    const keyRange = getNodeRange(pair.key);
    if (!keyRange) {
        return null;
    }

    const valueRange = getPresentNodeRange(pair.value);
    return {
        start: keyRange[0],
        end: valueRange?.[2] ?? findLineEndWithNewline(source, keyRange[1])
    };
}

export class ScenarioYamlDocument {
    private constructor(
        private readonly source: string,
        private readonly parsed: ReturnType<typeof parseDocument>,
        readonly errors: readonly string[]
    ) {}

    static parse(source: string): ScenarioYamlDocument {
        const parsed = parseDocument(source, {
            keepSourceTokens: true,
            prettyErrors: false,
            uniqueKeys: false
        });
        return new ScenarioYamlDocument(
            source,
            parsed,
            parsed.errors.map(error => error.message)
        );
    }

    findField(sectionName: string, fieldName: string): ScenarioYamlField | null {
        const fieldPair = this.findFieldPair(sectionName, fieldName);
        if (!fieldPair) {
            return null;
        }

        const keyRange = getNodeRange(fieldPair.key);
        const sourceRange = pairSourceRange(this.source, fieldPair);
        if (!keyRange || !sourceRange) {
            return null;
        }

        const rawValueRange = getPresentNodeRange(fieldPair.value);
        return {
            key: fieldName,
            value: getNodeValue(fieldPair.value),
            pairRange: sourceRange,
            valueRange: rawValueRange
                ? { start: rawValueRange[0], end: rawValueRange[1] }
                : null,
            lineStart: findLineStart(this.source, keyRange[0]),
            lineEnd: findLineEnd(this.source, keyRange[1])
        };
    }

    readScalar(sectionName: string, fieldName: string): string | undefined {
        const fieldPair = this.findFieldPair(sectionName, fieldName);
        if (!fieldPair || !isScalar(fieldPair.value) || fieldPair.value.value === null) {
            return undefined;
        }

        const valueRange = getPresentNodeRange(fieldPair.value);
        if (fieldPair.value.type === 'PLAIN' && valueRange) {
            return this.source.slice(valueRange[0], valueRange[1]).trim();
        }

        return typeof fieldPair.value.value === 'string'
            ? fieldPair.value.value
            : String(fieldPair.value.value);
    }

    findSection(sectionName: string): ScenarioYamlSection | null {
        const pair = this.findTopLevelPair(sectionName);
        if (!pair) {
            return null;
        }

        const keyRange = getNodeRange(pair.key);
        const sourceRange = pairSourceRange(this.source, pair);
        if (!keyRange || !sourceRange) {
            return null;
        }

        const rawValueRange = getPresentNodeRange(pair.value);
        const keyLineStart = findLineStart(this.source, keyRange[0]);
        const keyLineEndWithNewline = findLineEndWithNewline(this.source, keyRange[1]);
        const valueStartsOnKeyLine = rawValueRange
            ? findLineStart(this.source, rawValueRange[0]) === keyLineStart
            : false;

        let bodyRange: SourceRange;
        if (!rawValueRange) {
            bodyRange = { start: keyLineEndWithNewline, end: keyLineEndWithNewline };
        } else if (valueStartsOnKeyLine) {
            bodyRange = { start: rawValueRange[0], end: rawValueRange[1] };
        } else {
            bodyRange = {
                start: findLineStart(this.source, rawValueRange[0]),
                end: rawValueRange[2]
            };
        }

        const keyIndent = this.source.slice(keyLineStart, keyRange[0]);
        const itemIndent = rawValueRange && !valueStartsOnKeyLine
            ? this.source.slice(findLineStart(this.source, rawValueRange[0]), rawValueRange[0])
            : `${keyIndent}    `;

        return {
            name: sectionName,
            pairRange: sourceRange,
            valueRange: rawValueRange
                ? { start: rawValueRange[0], end: rawValueRange[1] }
                : null,
            bodyRange,
            keyIndent,
            itemIndent
        };
    }

    readRecords(sectionName: string): readonly ScenarioYamlRecord[] {
        const sectionPair = this.findTopLevelPair(sectionName);
        if (!sectionPair || !isSeq(sectionPair.value)) {
            return [];
        }

        const records: ScenarioYamlRecord[] = [];
        for (const item of sectionPair.value.items) {
            if (!isMap(item) || item.items.length === 0) {
                continue;
            }

            const recordPair = item.items[0];
            if (!isPair(recordPair)) {
                continue;
            }
            const recordKey = getScalarKey(recordPair.key);
            const keyRange = getNodeRange(recordPair.key);
            if (!recordKey || !keyRange) {
                continue;
            }

            const fields = new Map<string, unknown>();
            if (isMap(recordPair.value)) {
                for (const fieldPair of recordPair.value.items) {
                    if (!isPair(fieldPair)) {
                        continue;
                    }
                    const fieldKey = getScalarKey(fieldPair.key);
                    if (fieldKey) {
                        fields.set(fieldKey, getNodeValue(fieldPair.value));
                    }
                }
            }

            const itemRange = getNodeRange(item);
            const rawEnd = itemRange?.[1] ?? keyRange[1];
            records.push({
                key: recordKey,
                fields,
                range: {
                    start: keyRange[0],
                    end: withoutTrailingLineBreak(this.source, rawEnd)
                }
            });
        }

        return records;
    }

    requireValidForEdit(): void {
        if (this.errors.length > 0) {
            throw new Error(`Unsafe YAML edit: ${this.errors.join('; ')}`);
        }
    }

    private findTopLevelPair(key: string): Pair | null {
        if (!isMap(this.parsed.contents)) {
            return null;
        }

        return this.findMapPair(this.parsed.contents, key);
    }

    private findFieldPair(sectionName: string, fieldName: string): Pair | null {
        const sectionPair = this.findTopLevelPair(sectionName);
        if (!sectionPair || !isMap(sectionPair.value)) {
            return null;
        }

        return this.findMapPair(sectionPair.value, fieldName);
    }

    private findMapPair(map: unknown, key: string): Pair | null {
        if (!isMap(map)) {
            return null;
        }

        for (const item of map.items) {
            if (isPair(item) && getScalarKey(item.key) === key) {
                return item;
            }
        }

        return null;
    }
}

function getSourceNewline(source: string): '\n' | '\r\n' {
    return source.includes('\r\n') ? '\r\n' : '\n';
}

function renderSectionItems(itemText: string, indent: string, newline: string): string {
    return itemText
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .split('\n')
        .map(line => line.length > 0 ? `${indent}${line}` : line)
        .join(newline);
}

function getInlineValueRange(source: string, section: ScenarioYamlSection): SourceRange | null {
    if (!section.valueRange) {
        return null;
    }
    if (findLineStart(source, section.valueRange.start) !== findLineStart(source, section.pairRange.start)) {
        return null;
    }

    let start = section.valueRange.start;
    while (start > section.pairRange.start && (source[start - 1] === ' ' || source[start - 1] === '\t')) {
        start -= 1;
    }
    return { start, end: section.valueRange.end };
}

export function getSectionInsertion(
    source: string,
    sectionName: string,
    itemText: string
): SourceEdit | null {
    const document = ScenarioYamlDocument.parse(source);
    document.requireValidForEdit();
    const section = document.findSection(sectionName);
    if (!section) {
        return null;
    }

    const newline = getSourceNewline(source);
    const renderedItem = renderSectionItems(itemText, section.itemIndent, newline);
    const inlineValueRange = getInlineValueRange(source, section);
    if (inlineValueRange) {
        return {
            range: inlineValueRange,
            text: `${newline}${renderedItem}`
        };
    }

    const insertOffset = section.bodyRange.start === section.bodyRange.end
        ? section.bodyRange.start
        : section.bodyRange.end;
    const needsLeadingNewline = insertOffset > 0 && !source.slice(0, insertOffset).endsWith(newline);
    const needsTrailingNewline = insertOffset < source.length || source.endsWith(newline);
    return {
        range: { start: insertOffset, end: insertOffset },
        text: `${needsLeadingNewline ? newline : ''}${renderedItem}${needsTrailingNewline ? newline : ''}`
    };
}

export function getSectionBodyReplacement(
    source: string,
    sectionName: string,
    bodyText: string
): SourceEdit | null {
    const document = ScenarioYamlDocument.parse(source);
    document.requireValidForEdit();
    const section = document.findSection(sectionName);
    if (!section) {
        return null;
    }

    const inlineValueRange = getInlineValueRange(source, section);
    const range = inlineValueRange ?? section.bodyRange;
    if (bodyText.length === 0) {
        return { range, text: '' };
    }

    const newline = getSourceNewline(source);
    const renderedBody = renderSectionItems(bodyText, section.itemIndent, newline);
    if (inlineValueRange) {
        return {
            range,
            text: `${newline}${renderedBody}`
        };
    }

    const replacedText = source.slice(range.start, range.end);
    const needsTrailingNewline = range.end < source.length || replacedText.endsWith(newline);
    return {
        range,
        text: `${renderedBody}${needsTrailingNewline ? newline : ''}`
    };
}
