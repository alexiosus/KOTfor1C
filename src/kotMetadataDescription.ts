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

function dedentBlockLines(lines: string[]): string[] {
    let minIndent: number | null = null;
    for (const line of lines) {
        if (!line.trim()) {
            continue;
        }
        const indent = getIndent(line);
        if (minIndent === null || indent < minIndent) {
            minIndent = indent;
        }
    }

    if (minIndent === null || minIndent <= 0) {
        return lines;
    }

    return lines.map(line => {
        if (!line.trim()) {
            return '';
        }
        return line.length > minIndent ? line.slice(minIndent) : '';
    });
}

export function parseKotScenarioDescription(documentText: string): string {
    const lines = documentText.split(/\r\n|\r|\n/);
    let metadataStart = -1;

    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
        const line = lines[lineIndex];
        if (line.trim() === 'KOTМетаданные:' && getIndent(line) === 0) {
            metadataStart = lineIndex;
            break;
        }
    }

    if (metadataStart === -1) {
        return '';
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

        if (rawValue.startsWith('|') || rawValue.startsWith('>')) {
            const contentLines: string[] = [];
            for (let bodyLineIndex = lineIndex + 1; bodyLineIndex < metadataEnd; bodyLineIndex++) {
                const bodyLine = lines[bodyLineIndex];
                const bodyIndent = getIndent(bodyLine);
                const bodyTrimmed = bodyLine.trim();

                if (bodyTrimmed.length > 0 && bodyIndent <= descriptionIndent) {
                    break;
                }

                if (bodyLine.length <= descriptionIndent) {
                    contentLines.push('');
                    continue;
                }

                contentLines.push(normalizeLeadingTabs(bodyLine));
            }

            const dedented = dedentBlockLines(contentLines);
            return normalizeDescriptionContent(dedented.join('\n'));
        }

        return normalizeDescriptionContent(parseInlineYamlScalar(rawValue));
    }

    return '';
}
