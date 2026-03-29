import { migrateLegacyPhaseSwitcherMetadata } from './phaseSwitcherMetadata';

function normalizeLeadingTabs(line: string): string {
    return line.replace(/^\t+/, tabs => '    '.repeat(tabs.length));
}

function getIndent(line: string): number {
    const normalized = normalizeLeadingTabs(line);
    return (normalized.match(/^(\s*)/) || [''])[0].length;
}

function parseInlineYamlScalar(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (!trimmed) {
        return '';
    }

    if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
        return trimmed.slice(1, -1).replace(/\\\\/g, '\\').replace(/\\"/g, '"');
    }

    if (trimmed.length >= 2 && trimmed.startsWith('\'') && trimmed.endsWith('\'')) {
        return trimmed.slice(1, -1).replace(/''/g, '\'');
    }

    return trimmed;
}

function normalizeDescriptionContent(rawValue: string): string {
    const trimmed = rawValue.trim();
    if (!trimmed) {
        return '';
    }

    const nonEmptyLines = trimmed
        .split(/\r\n|\r|\n/)
        .map(line => line.trim())
        .filter(line => line.length > 0);

    if (nonEmptyLines.length > 0 && nonEmptyLines.every(line => line === '-')) {
        return '';
    }

    return trimmed;
}

interface KotDescriptionSection {
    metadataStart: number;
    metadataEnd: number;
    descriptionStart: number;
    descriptionEnd: number;
    descriptionIndent: number;
}

function findKotDescriptionSection(lines: string[]): KotDescriptionSection | null {
    let metadataStart = -1;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (line.trim() === 'KOTМетаданные:' && getIndent(line) === 0) {
            metadataStart = lineIndex;
            break;
        }
    }

    if (metadataStart === -1) {
        return null;
    }

    let metadataEnd = lines.length;
    for (let lineIndex = metadataStart + 1; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith('#')) {
            continue;
        }
        if (getIndent(line) === 0 && /^[^:#][^:]*:\s*/.test(trimmed)) {
            metadataEnd = lineIndex;
            break;
        }
    }

    for (let lineIndex = metadataStart + 1; lineIndex < metadataEnd; lineIndex++) {
        const line = lines[lineIndex];
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }

        const descriptionMatch = trimmed.match(/^Описание:\s*(.*)$/);
        if (!descriptionMatch) {
            continue;
        }

        const rawValue = (descriptionMatch[1] || '').trim();
        const descriptionIndent = getIndent(line);
        const descriptionContentIndent = descriptionIndent + 4;

        if (rawValue.startsWith('|') || rawValue.startsWith('>')) {
            let descriptionEnd = metadataEnd;
            for (let bodyLineIndex = lineIndex + 1; bodyLineIndex < metadataEnd; bodyLineIndex++) {
                const bodyLine = lines[bodyLineIndex];
                const bodyIndent = getIndent(bodyLine);
                const bodyTrimmed = bodyLine.trim();

                if (bodyTrimmed.length > 0 && bodyIndent <= descriptionIndent) {
                    descriptionEnd = bodyLineIndex;
                    break;
                }

                if (bodyTrimmed.length > 0 && bodyIndent < descriptionContentIndent) {
                    descriptionEnd = bodyLineIndex;
                    break;
                }
            }

            return {
                metadataStart,
                metadataEnd,
                descriptionStart: lineIndex,
                descriptionEnd,
                descriptionIndent
            };
        }

        return {
            metadataStart,
            metadataEnd,
            descriptionStart: lineIndex,
            descriptionEnd: lineIndex + 1,
            descriptionIndent
        };
    }

    return null;
}

export function parseKotScenarioDescription(documentText: string): string {
    const lines = documentText.split(/\r\n|\r|\n/);
    const section = findKotDescriptionSection(lines);
    if (!section) {
        return '';
    }

    const descriptionLine = lines[section.descriptionStart];
    const trimmed = descriptionLine.trim();
    const descriptionMatch = trimmed.match(/^Описание:\s*(.*)$/);
    if (!descriptionMatch) {
        return '';
    }

    const rawValue = (descriptionMatch[1] || '').trim();
    const descriptionContentIndent = section.descriptionIndent + 4;

    if (rawValue.startsWith('|') || rawValue.startsWith('>')) {
        const contentLines: string[] = [];
        for (let bodyLineIndex = section.descriptionStart + 1; bodyLineIndex < section.descriptionEnd; bodyLineIndex++) {
            const normalizedBodyLine = normalizeLeadingTabs(lines[bodyLineIndex]);
            if (normalizedBodyLine.length <= descriptionContentIndent) {
                contentLines.push('');
                continue;
            }

            contentLines.push(normalizedBodyLine.slice(descriptionContentIndent));
        }

        return normalizeDescriptionContent(contentLines.join('\n'));
    }

    return normalizeDescriptionContent(parseInlineYamlScalar(rawValue));
}

export function normalizeGeneratedKotDescription(rawValue: string): string {
    let normalized = rawValue.replace(/\r\n|\r/g, '\n').trim();

    const fencedMatch = normalized.match(/^```(?:[a-z0-9_-]+)?\n([\s\S]*?)\n```$/i);
    if (fencedMatch?.[1]) {
        normalized = fencedMatch[1].trim();
    }

    normalized = normalized.replace(/^Описание:\s*/i, '').trim();
    normalized = normalized
        .split('\n')
        .map(line => line.replace(/\t/g, '    ').trimEnd())
        .join('\n')
        .trim();

    return normalized;
}

function wrapNormalizedDescription(rawValue: string, maxLineLength: number): string {
    if (maxLineLength <= 0) {
        return rawValue;
    }

    const wrappedLines: string[] = [];
    const paragraphs = rawValue.split('\n');

    for (const paragraph of paragraphs) {
        const normalizedParagraph = paragraph.trim();
        if (normalizedParagraph.length === 0) {
            wrappedLines.push('');
            continue;
        }

        const words = normalizedParagraph.split(/\s+/).filter(Boolean);
        let currentLine = '';

        for (const word of words) {
            if (currentLine.length === 0) {
                currentLine = word;
                continue;
            }

            const candidate = `${currentLine} ${word}`;
            if (candidate.length <= maxLineLength) {
                currentLine = candidate;
                continue;
            }

            wrappedLines.push(currentLine);
            currentLine = word;
        }

        if (currentLine.length > 0) {
            wrappedLines.push(currentLine);
        }
    }

    while (wrappedLines.length > 0 && wrappedLines[wrappedLines.length - 1] === '') {
        wrappedLines.pop();
    }

    return wrappedLines.join('\n');
}

export function upsertKotScenarioDescription(
    documentText: string,
    description: string,
    maxVisibleLineLength = 100
): string {
    const normalizedDescription = normalizeGeneratedKotDescription(description);
    const lineEnding = documentText.includes('\r\n') ? '\r\n' : '\n';

    let workingText = documentText;
    let lines = workingText.split(/\r\n|\r|\n/);
    let section = findKotDescriptionSection(lines);

    if (!section) {
        const migrated = migrateLegacyPhaseSwitcherMetadata(documentText, {
            migrateLegacyPhaseSwitcherTags: false
        });
        workingText = migrated.content;
        lines = workingText.split(/\r\n|\r|\n/);
        section = findKotDescriptionSection(lines);
        if (!section) {
            return documentText;
        }
    }

    const contentWidth = Math.max(20, maxVisibleLineLength - (section.descriptionIndent + 4));
    const wrappedDescription = wrapNormalizedDescription(normalizedDescription, contentWidth);
    const descriptionLines = wrappedDescription.length > 0
        ? wrappedDescription.split('\n')
        : [''];
    const descriptionIndent = ' '.repeat(section.descriptionIndent);
    const contentIndent = ' '.repeat(section.descriptionIndent + 4);
    let replaceEnd = section.descriptionEnd;
    let hasTrailingDashMarker = false;
    if (
        replaceEnd < section.metadataEnd &&
        lines[replaceEnd].trim() === '-' &&
        getIndent(lines[replaceEnd]) === section.descriptionIndent
    ) {
        hasTrailingDashMarker = true;
        replaceEnd += 1;
    }

    const replacementLines = [
        `${descriptionIndent}Описание: |`,
        ...descriptionLines.map(line => `${contentIndent}${line}`),
        ...(hasTrailingDashMarker ? [`${descriptionIndent}-`] : [])
    ];

    lines.splice(section.descriptionStart, replaceEnd - section.descriptionStart, ...replacementLines);
    return lines.join(lineEnding);
}
