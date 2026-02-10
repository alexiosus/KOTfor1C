interface LegacyPhaseSwitcherMetadata {
    hasTab: boolean;
    hasDefault: boolean;
    hasOrder: boolean;
    tabRaw?: string;
    defaultRaw?: string;
    orderRaw?: string;
    lineIndexes: Set<number>;
}

interface KotMetadataStructure {
    metadataLineIndex: number;
    metadataIndent: number;
    metadataEndIndex: number;
    hasDescription: boolean;
    phaseLineIndex: number;
    phaseIndent: number;
    phaseEndIndex: number;
    hasTab: boolean;
    hasDefault: boolean;
    hasOrder: boolean;
    tabRaw?: string;
    defaultRaw?: string;
    orderRaw?: string;
}

export interface PhaseSwitcherMetadata {
    tabName?: string;
    defaultState?: boolean;
    order?: number;
    hasTab: boolean;
    hasDefault: boolean;
    hasOrder: boolean;
    hasAny: boolean;
    source: 'none' | 'legacy' | 'kot' | 'both';
}

export interface PhaseSwitcherMetadataMigrationResult {
    changed: boolean;
    content: string;
}

export interface PhaseSwitcherMetadataMigrationOptions {
    cachedKotMetadataBlock?: string;
}

interface KotMetadataPresence {
    hasDescription: boolean;
    hasPhaseSwitcher: boolean;
    hasTab: boolean;
    hasOrder: boolean;
    hasDefault: boolean;
}

function normalizeLeadingTabs(line: string): string {
    return line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
}

function getIndent(line: string): number {
    const normalized = normalizeLeadingTabs(line);
    const match = normalized.match(/^(\s*)/);
    return match ? match[1].length : 0;
}

function stripBom(line: string): string {
    return line.replace(/^\uFEFF/, '');
}

function isIgnorableLine(line: string): boolean {
    const trimmed = stripBom(line).trim();
    return trimmed.length === 0 || trimmed.startsWith('#');
}

function isYamlKeyLine(trimmedNoBom: string): boolean {
    return /^[^:#][^:]*:\s*(.*)$/.test(trimmedNoBom);
}

function findSectionEnd(lines: string[], startIndex: number, startIndent: number, maxExclusive: number = lines.length): number {
    for (let index = startIndex + 1; index < maxExclusive; index++) {
        const line = lines[index];
        if (isIgnorableLine(line)) {
            continue;
        }

        const indent = getIndent(line);
        const trimmedNoBom = stripBom(line).trim();
        if (indent <= startIndent && isYamlKeyLine(trimmedNoBom)) {
            return index;
        }
    }

    return maxExclusive;
}

function parseYamlScalar(rawValue: string | undefined): string {
    const raw = (rawValue || '').trim();
    if (!raw) {
        return '';
    }

    if (raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"')) {
        const inner = raw.slice(1, -1);
        return inner
            .replace(/\\\\/g, '\\')
            .replace(/\\"/g, '"');
    }

    if (raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")) {
        const inner = raw.slice(1, -1);
        return inner.replace(/''/g, "'");
    }

    return raw;
}

function parseBoolean(rawValue: string | undefined): boolean | undefined {
    const normalized = parseYamlScalar(rawValue).trim().toLowerCase();
    if (normalized === 'true') {
        return true;
    }
    if (normalized === 'false') {
        return false;
    }
    return undefined;
}

function parseNumber(rawValue: string | undefined): number | undefined {
    const normalized = parseYamlScalar(rawValue).trim();
    if (!normalized) {
        return undefined;
    }
    const parsed = Number.parseInt(normalized, 10);
    return Number.isNaN(parsed) ? undefined : parsed;
}

function parseString(rawValue: string | undefined): string | undefined {
    const normalized = parseYamlScalar(rawValue).trim();
    return normalized.length > 0 ? normalized : undefined;
}

function escapeDoubleQuotedString(value: string): string {
    return value
        .replace(/\\/g, '\\\\')
        .replace(/"/g, '\\"');
}

function formatStringScalar(rawValue: string | undefined): string {
    const value = parseYamlScalar(rawValue).trim();
    return `"${escapeDoubleQuotedString(value)}"`;
}

function formatBooleanScalar(rawValue: string | undefined): string {
    const parsed = parseBoolean(rawValue);
    if (parsed !== undefined) {
        return parsed ? 'true' : 'false';
    }

    const normalized = parseYamlScalar(rawValue).trim();
    if (!normalized) {
        return '';
    }

    return `"${escapeDoubleQuotedString(normalized)}"`;
}

function formatOrderScalar(rawValue: string | undefined): string {
    const parsed = parseNumber(rawValue);
    if (parsed !== undefined) {
        return String(parsed);
    }

    const normalized = parseYamlScalar(rawValue).trim();
    if (!normalized) {
        return '';
    }

    return `"${escapeDoubleQuotedString(normalized)}"`;
}

function parseLegacyPhaseSwitcherMetadata(lines: string[]): LegacyPhaseSwitcherMetadata {
    const result: LegacyPhaseSwitcherMetadata = {
        hasTab: false,
        hasDefault: false,
        hasOrder: false,
        lineIndexes: new Set<number>()
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const markerMatch = line.match(/^\s*#\s*PhaseSwitcher_(Tab|Default|OrderOnTab):\s*(.*)$/);
        if (!markerMatch) {
            continue;
        }

        const key = markerMatch[1];
        const value = markerMatch[2]?.trim() || '';
        result.lineIndexes.add(index);

        if (key === 'Tab') {
            result.hasTab = true;
            result.tabRaw = value;
        } else if (key === 'Default') {
            result.hasDefault = true;
            result.defaultRaw = value;
        } else if (key === 'OrderOnTab') {
            result.hasOrder = true;
            result.orderRaw = value;
        }
    }

    return result;
}

function findKotMetadataStructure(lines: string[]): KotMetadataStructure {
    const empty: KotMetadataStructure = {
        metadataLineIndex: -1,
        metadataIndent: -1,
        metadataEndIndex: -1,
        hasDescription: false,
        phaseLineIndex: -1,
        phaseIndent: -1,
        phaseEndIndex: -1,
        hasTab: false,
        hasDefault: false,
        hasOrder: false
    };

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmedNoBom = stripBom(line).trim();
        if (getIndent(line) !== 0 || trimmedNoBom !== 'KOTМетаданные:') {
            continue;
        }

        empty.metadataLineIndex = index;
        empty.metadataIndent = getIndent(line);
        empty.metadataEndIndex = findSectionEnd(lines, index, empty.metadataIndent);
        break;
    }

    if (empty.metadataLineIndex === -1) {
        return empty;
    }

    for (let index = empty.metadataLineIndex + 1; index < empty.metadataEndIndex; index++) {
        const line = lines[index];
        if (isIgnorableLine(line)) {
            continue;
        }

        const indent = getIndent(line);
        const trimmedNoBom = stripBom(line).trim();
        if (indent <= empty.metadataIndent) {
            continue;
        }

        if (/^Описание:\s*(.*)$/.test(trimmedNoBom)) {
            empty.hasDescription = true;
        }

        if (empty.phaseLineIndex === -1 && trimmedNoBom === 'PhaseSwitcher:') {
            empty.phaseLineIndex = index;
            empty.phaseIndent = indent;
            empty.phaseEndIndex = findSectionEnd(lines, index, indent, empty.metadataEndIndex);
        }
    }

    if (empty.phaseLineIndex === -1) {
        return empty;
    }

    for (let index = empty.phaseLineIndex + 1; index < empty.phaseEndIndex; index++) {
        const line = lines[index];
        if (isIgnorableLine(line) || getIndent(line) <= empty.phaseIndent) {
            continue;
        }

        const match = stripBom(line).trim().match(/^(Tab|Default|OrderOnTab):\s*(.*)$/);
        if (!match) {
            continue;
        }

        const key = match[1];
        const value = match[2]?.trim() || '';

        if (key === 'Tab') {
            empty.hasTab = true;
            empty.tabRaw = value;
        } else if (key === 'Default') {
            empty.hasDefault = true;
            empty.defaultRaw = value;
        } else if (key === 'OrderOnTab') {
            empty.hasOrder = true;
            empty.orderRaw = value;
        }
    }

    return empty;
}

interface KotMetadataBlockRange {
    start: number;
    end: number;
}

function findTopLevelKotMetadataRanges(lines: string[]): KotMetadataBlockRange[] {
    const ranges: KotMetadataBlockRange[] = [];

    for (let index = 0; index < lines.length; index++) {
        const line = lines[index];
        const trimmedNoBom = stripBom(line).trim();
        if (getIndent(line) !== 0 || trimmedNoBom !== 'KOTМетаданные:') {
            continue;
        }

        const end = findSectionEnd(lines, index, 0);
        ranges.push({ start: index, end });
        index = end - 1;
    }

    return ranges;
}

function parsePhaseSwitcherMetadataFromRaw(
    hasTab: boolean,
    hasDefault: boolean,
    hasOrder: boolean,
    tabRaw?: string,
    defaultRaw?: string,
    orderRaw?: string
): Omit<PhaseSwitcherMetadata, 'source' | 'hasAny'> {
    return {
        tabName: hasTab ? parseString(tabRaw) : undefined,
        defaultState: hasDefault ? parseBoolean(defaultRaw) : undefined,
        order: hasOrder ? parseNumber(orderRaw) : undefined,
        hasTab,
        hasDefault,
        hasOrder
    };
}

export function parsePhaseSwitcherMetadata(documentText: string): PhaseSwitcherMetadata {
    const lines = documentText.split(/\r\n|\r|\n/);
    const legacy = parseLegacyPhaseSwitcherMetadata(lines);
    const kot = findKotMetadataStructure(lines);

    const legacyParsed = parsePhaseSwitcherMetadataFromRaw(
        legacy.hasTab,
        legacy.hasDefault,
        legacy.hasOrder,
        legacy.tabRaw,
        legacy.defaultRaw,
        legacy.orderRaw
    );
    const kotParsed = parsePhaseSwitcherMetadataFromRaw(
        kot.hasTab,
        kot.hasDefault,
        kot.hasOrder,
        kot.tabRaw,
        kot.defaultRaw,
        kot.orderRaw
    );

    const hasLegacyAny = legacy.hasTab || legacy.hasDefault || legacy.hasOrder;
    const hasKotAny = kot.hasTab || kot.hasDefault || kot.hasOrder;

    const result: PhaseSwitcherMetadata = {
        tabName: legacyParsed.tabName,
        defaultState: legacyParsed.defaultState,
        order: legacyParsed.order,
        hasTab: legacyParsed.hasTab,
        hasDefault: legacyParsed.hasDefault,
        hasOrder: legacyParsed.hasOrder,
        hasAny: hasLegacyAny,
        source: hasLegacyAny ? 'legacy' : 'none'
    };

    if (hasKotAny) {
        if (kotParsed.hasTab) {
            result.tabName = kotParsed.tabName;
            result.hasTab = true;
        }
        if (kotParsed.hasDefault) {
            result.defaultState = kotParsed.defaultState;
            result.hasDefault = true;
        }
        if (kotParsed.hasOrder) {
            result.order = kotParsed.order;
            result.hasOrder = true;
        }
    }

    result.hasAny = result.hasTab || result.hasDefault || result.hasOrder;
    if (hasKotAny && hasLegacyAny) {
        result.source = 'both';
    } else if (hasKotAny) {
        result.source = 'kot';
    } else if (hasLegacyAny) {
        result.source = 'legacy';
    } else {
        result.source = 'none';
    }

    return result;
}

function buildPhaseSwitcherLinesFromLegacy(legacy: LegacyPhaseSwitcherMetadata, phaseIndent: number): string[] {
    const keyIndent = ' '.repeat(phaseIndent + 4);
    const lines: string[] = [`${' '.repeat(phaseIndent)}PhaseSwitcher:`];

    if (legacy.hasTab) {
        lines.push(`${keyIndent}Tab: ${formatStringScalar(legacy.tabRaw)}`);
    }
    if (legacy.hasOrder) {
        lines.push(`${keyIndent}OrderOnTab: ${formatOrderScalar(legacy.orderRaw)}`);
    }
    if (legacy.hasDefault) {
        lines.push(`${keyIndent}Default: ${formatBooleanScalar(legacy.defaultRaw)}`);
    }

    return lines;
}

function buildDescriptionLines(metadataIndent: number): string[] {
    return [
        `${' '.repeat(metadataIndent + 4)}Описание: |`,
        `${' '.repeat(metadataIndent + 8)}`
    ];
}

function resolveKotMetadataInsertIndex(lines: string[]): number {
    const dataSectionIndex = lines.findIndex(line =>
        getIndent(line) === 0 && stripBom(line).trim() === 'ДанныеСценария:'
    );
    if (dataSectionIndex !== -1) {
        return findSectionEnd(lines, dataSectionIndex, 0);
    }

    const fileTypeIndex = lines.findIndex(line =>
        getIndent(line) === 0 && /^ТипФайла:\s*/.test(stripBom(line).trim())
    );
    if (fileTypeIndex !== -1) {
        return fileTypeIndex + 1;
    }

    return 0;
}

function trimOuterEmptyLines(lines: string[]): string[] {
    let start = 0;
    let end = lines.length;

    while (start < end && lines[start].trim() === '') {
        start++;
    }

    const shouldKeepTrailingWhitespaceLine = (index: number): boolean => {
        const currentLine = lines[index];
        if (currentLine.trim() !== '') {
            return false;
        }

        const currentIndent = getIndent(currentLine);
        for (let prevIndex = index - 1; prevIndex >= start; prevIndex--) {
            const prevLine = lines[prevIndex];
            const prevTrimmed = stripBom(prevLine).trim();
            if (prevTrimmed.length === 0) {
                continue;
            }

            // Preserve intentional empty content line for block scalar fields
            // such as "Описание: |" to keep default editable indentation.
            if (/^Описание:\s*[|>][-+0-9]*\s*$/.test(prevTrimmed) && currentIndent > getIndent(prevLine)) {
                return true;
            }
            return false;
        }

        return false;
    };

    while (end > start && lines[end - 1].trim() === '') {
        if (shouldKeepTrailingWhitespaceLine(end - 1)) {
            break;
        }
        end--;
    }

    return lines.slice(start, end);
}

function normalizeCachedKotMetadataBlockLines(rawBlock: string | undefined): string[] {
    if (!rawBlock) {
        return [];
    }

    const lines = trimOuterEmptyLines(rawBlock.split(/\r\n|\r|\n/));
    if (lines.length === 0) {
        return [];
    }

    const firstLine = stripBom(lines[0]).trim();
    if (firstLine !== 'KOTМетаданные:' || getIndent(lines[0]) !== 0) {
        return [];
    }

    return lines;
}

function getKotMetadataPresenceFromBlockLines(blockLines: string[]): KotMetadataPresence | null {
    if (blockLines.length === 0) {
        return null;
    }

    const structure = findKotMetadataStructure(blockLines);
    if (structure.metadataLineIndex === -1) {
        return null;
    }

    return {
        hasDescription: structure.hasDescription,
        hasPhaseSwitcher: structure.phaseLineIndex !== -1,
        hasTab: structure.hasTab,
        hasOrder: structure.hasOrder,
        hasDefault: structure.hasDefault
    };
}

function isKotMetadataMissingComparedTo(
    current: KotMetadataPresence,
    baseline: KotMetadataPresence
): boolean {
    if (baseline.hasDescription && !current.hasDescription) {
        return true;
    }
    if (baseline.hasPhaseSwitcher && !current.hasPhaseSwitcher) {
        return true;
    }
    if (baseline.hasTab && !current.hasTab) {
        return true;
    }
    if (baseline.hasOrder && !current.hasOrder) {
        return true;
    }
    if (baseline.hasDefault && !current.hasDefault) {
        return true;
    }

    return false;
}

export function shouldKeepCachedKotMetadataBlock(
    existingCachedBlock: string | undefined,
    candidateBlock: string | undefined
): boolean {
    const existingLines = normalizeCachedKotMetadataBlockLines(existingCachedBlock);
    if (existingLines.length === 0) {
        return false;
    }

    const candidateLines = normalizeCachedKotMetadataBlockLines(candidateBlock);
    if (candidateLines.length === 0) {
        return true;
    }

    const existingPresence = getKotMetadataPresenceFromBlockLines(existingLines);
    const candidatePresence = getKotMetadataPresenceFromBlockLines(candidateLines);
    if (!existingPresence) {
        return false;
    }
    if (!candidatePresence) {
        return true;
    }

    return isKotMetadataMissingComparedTo(candidatePresence, existingPresence);
}

function insertBlockWithSpacing(lines: string[], insertAt: number, rawBlockLines: string[]): void {
    const blockLines = trimOuterEmptyLines(rawBlockLines);
    if (blockLines.length === 0) {
        return;
    }

    const needsLeadingEmpty = insertAt > 0 && lines[insertAt - 1].trim() !== '';
    const needsTrailingEmpty = insertAt < lines.length && lines[insertAt].trim() !== '';

    const toInsert = [
        ...(needsLeadingEmpty ? [''] : []),
        ...blockLines,
        ...(needsTrailingEmpty ? [''] : [])
    ];
    lines.splice(insertAt, 0, ...toInsert);
}

export function extractTopLevelKotMetadataBlock(documentText: string): string | null {
    const lines = documentText.split(/\r\n|\r|\n/);
    const ranges = findTopLevelKotMetadataRanges(lines);
    if (ranges.length === 0) {
        return null;
    }

    const firstRange = ranges[0];
    const blockLines = trimOuterEmptyLines(lines.slice(firstRange.start, firstRange.end));
    if (blockLines.length === 0) {
        return null;
    }

    return blockLines.join('\n');
}

export function migrateLegacyPhaseSwitcherMetadata(
    documentText: string,
    options: PhaseSwitcherMetadataMigrationOptions = {}
): PhaseSwitcherMetadataMigrationResult {
    const lineEnding = documentText.includes('\r\n') ? '\r\n' : '\n';
    const originalLines = documentText.split(/\r\n|\r|\n/);
    const legacy = parseLegacyPhaseSwitcherMetadata(originalLines);
    const hasLegacyMetadata = legacy.hasTab || legacy.hasDefault || legacy.hasOrder;
    const cachedKotMetadataBlockLines = normalizeCachedKotMetadataBlockLines(options.cachedKotMetadataBlock);
    const cachedKotMetadataPresence = getKotMetadataPresenceFromBlockLines(cachedKotMetadataBlockLines);

    const lines = originalLines.filter((_, index) => !legacy.lineIndexes.has(index));

    // Keep the first top-level KOT metadata block and remove duplicates.
    // This prevents accidental block multiplication after repeated migrations.
    const duplicateRanges = findTopLevelKotMetadataRanges(lines);
    if (duplicateRanges.length > 1) {
        for (let rangeIndex = duplicateRanges.length - 1; rangeIndex >= 1; rangeIndex--) {
            const range = duplicateRanges[rangeIndex];
            lines.splice(range.start, range.end - range.start);

            // Collapse excessive blank lines left by removed duplicate blocks.
            if (range.start > 0 && range.start < lines.length) {
                if (lines[range.start - 1].trim() === '' && lines[range.start].trim() === '') {
                    lines.splice(range.start, 1);
                }
            }
        }
    }

    let kot = findKotMetadataStructure(lines);

    // If current block is missing pieces compared to cached block, restore cached version.
    if (kot.metadataLineIndex !== -1 && cachedKotMetadataBlockLines.length > 0 && cachedKotMetadataPresence) {
        const currentKotPresence: KotMetadataPresence = {
            hasDescription: kot.hasDescription,
            hasPhaseSwitcher: kot.phaseLineIndex !== -1,
            hasTab: kot.hasTab,
            hasOrder: kot.hasOrder,
            hasDefault: kot.hasDefault
        };

        if (isKotMetadataMissingComparedTo(currentKotPresence, cachedKotMetadataPresence)) {
            lines.splice(kot.metadataLineIndex, kot.metadataEndIndex - kot.metadataLineIndex);
            const insertAt = resolveKotMetadataInsertIndex(lines);
            insertBlockWithSpacing(lines, insertAt, cachedKotMetadataBlockLines);
            kot = findKotMetadataStructure(lines);
        }
    }

    if (kot.metadataLineIndex === -1) {
        const metadataLines: string[] = cachedKotMetadataBlockLines.length > 0
            ? [...cachedKotMetadataBlockLines]
            : [
                'KOTМетаданные:',
                ...buildDescriptionLines(0),
                ...(hasLegacyMetadata ? buildPhaseSwitcherLinesFromLegacy(legacy, 4) : [])
            ];
        const insertAt = resolveKotMetadataInsertIndex(lines);
        insertBlockWithSpacing(lines, insertAt, metadataLines);
        kot = findKotMetadataStructure(lines);
    }

    if (kot.metadataLineIndex !== -1 && !kot.hasDescription) {
        lines.splice(kot.metadataLineIndex + 1, 0, ...buildDescriptionLines(kot.metadataIndent));
        kot = findKotMetadataStructure(lines);
    }

    if (kot.metadataLineIndex !== -1 && hasLegacyMetadata) {
        if (kot.phaseLineIndex === -1) {
            const phaseLines = buildPhaseSwitcherLinesFromLegacy(legacy, kot.metadataIndent + 4);
            lines.splice(kot.metadataEndIndex, 0, ...phaseLines);
            kot = findKotMetadataStructure(lines);
        } else {
            const keyIndent = ' '.repeat(kot.phaseIndent + 4);
            const missingLines: string[] = [];

            if (legacy.hasTab && !kot.hasTab) {
                missingLines.push(`${keyIndent}Tab: ${formatStringScalar(legacy.tabRaw)}`);
            }
            if (legacy.hasOrder && !kot.hasOrder) {
                missingLines.push(`${keyIndent}OrderOnTab: ${formatOrderScalar(legacy.orderRaw)}`);
            }
            if (legacy.hasDefault && !kot.hasDefault) {
                missingLines.push(`${keyIndent}Default: ${formatBooleanScalar(legacy.defaultRaw)}`);
            }

            if (missingLines.length > 0) {
                lines.splice(kot.phaseEndIndex, 0, ...missingLines);
                kot = findKotMetadataStructure(lines);
            }
        }
    }

    if (kot.metadataLineIndex !== -1) {
        const blockLines = trimOuterEmptyLines(lines.slice(kot.metadataLineIndex, kot.metadataEndIndex));
        lines.splice(kot.metadataLineIndex, kot.metadataEndIndex - kot.metadataLineIndex);
        const insertAt = resolveKotMetadataInsertIndex(lines);
        insertBlockWithSpacing(lines, insertAt, blockLines);
    }

    const nextContent = lines.join(lineEnding);
    return {
        changed: nextContent !== documentText,
        content: nextContent
    };
}
