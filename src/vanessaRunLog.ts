export interface VanessaRunLogParseOptions {
    scenarioName?: string;
    featureContent?: string;
}

export interface VanessaFailureDetails {
    failureSummary?: string;
    failureDetails?: string;
    failureStepDescription?: string;
}

export interface VanessaStepLocation {
    featurePath?: string;
    featureLineNumber?: number;
    iteration?: number;
}

export interface VanessaFailedStep {
    readonly details: VanessaFailureDetails;
    readonly location: VanessaStepLocation | null;
}

export function extractFailedStep(content: string, options: VanessaRunLogParseOptions = {}): VanessaFailedStep | null {
    const lines = content.split(/\r\n|\r|\n/u);
    const featureLines = options.featureContent?.split(/\r\n|\r|\n/u);
    let featurePath: string | undefined;
    let scenarioName: string | undefined;
    let hasScenarioMarkers = false;
    let location: VanessaStepLocation | null = null;
    let failure: VanessaFailedStep | null = null;
    const visits = new Map<number, number>();
    for (const [index, line] of lines.entries()) {
        const nextFeature = extractFeaturePathFromRunLogLine(line);
        const nextScenario = extractScenarioNameFromRunLogLine(line);
        if (nextFeature || nextScenario) {
            featurePath = nextFeature || featurePath;
            if (nextFeature) { scenarioName = undefined; }
            if (nextScenario) { scenarioName = nextScenario; hasScenarioMarkers = true; }
            location = null;
            visits.clear();
        }
        if (!isRunLogLineForScenario(options.scenarioName?.trim(), scenarioName, hasScenarioMarkers)) { continue; }
        const lineNumber = extractFeatureLineNumberFromRunLogLine(line);
        if (lineNumber && (!featureLines || (featureLines[lineNumber - 1] !== undefined
            && isRunLogStepCompatibleWithFeatureLine(line, featureLines[lineNumber - 1])))) {
            const iteration = (visits.get(lineNumber) ?? 0) + 1;
            visits.set(lineNumber, iteration);
            location = { featurePath, featureLineNumber: lineNumber, ...(iteration > 1 ? { iteration } : {}) };
        }
        if (isFailedStepLogLine(line) && !/^\s*Failed\s*:/iu.test(line)) {
            const block = collectFailedStepLogBlock(lines, index);
            failure = {
                details: {
                    failureSummary: formatFailedStepSummaryFromLogBlock(block),
                    failureDetails: formatFailedStepDetailsFromLogBlock(block),
                    failureStepDescription: formatFailedStepDescriptionFromLogBlock(block)
                },
                location
            };
        }
    }
    if (failure) { return failure; }
    const details = extractFailedStepDetails(content, options);
    return details ? { details, location: null } : null;
}

export function extractFailedStepLocation(content: string, options: VanessaRunLogParseOptions = {}): VanessaStepLocation | null {
    return extractFailedStep(content, options)?.location ?? null;
}

interface VanessaRunLogStep {
    lineNumber: number;
    stepText?: string;
}

function stripWrappingQuotes(value: string): string {
    const trimmed = value.trim();
    if (trimmed.length < 2) {
        return trimmed;
    }

    const startsWithDoubleQuote = trimmed.startsWith('"') && trimmed.endsWith('"');
    const startsWithSingleQuote = trimmed.startsWith("'") && trimmed.endsWith("'");
    if (startsWithDoubleQuote || startsWithSingleQuote) {
        return trimmed.slice(1, -1).trim();
    }

    return trimmed;
}

export function extractFeaturePathFromRunLogLine(line: string): string | undefined {
    const match = line.match(/^\s*(?:Фича|Feature|ПолныйПутьКФиче|FullPathToFeature)\s*:\s*(.+?)\s*$/i);
    if (!match?.[1]) {
        return undefined;
    }

    const featurePath = stripWrappingQuotes(match[1]);
    return featurePath.length > 0 ? featurePath : undefined;
}

function extractRunLogStep(line: string): VanessaRunLogStep | undefined {
    const stepKeyword = '(?:Given|When|Then|And|But|Но|Тогда|Когда|Если|И|К\\s+тому\\s+же|Допустим|Дано|Пусть)';
    const patterns = [
        new RegExp(`\\((\\d+)\\)\\s*\\.?\\s*(?:Шаг|Step)\\s*:\\s*(.*?)\\s*$`, 'i'),
        /^\s*(?:НомерСтрокиФичи|FeatureLineNumber)\s*:\s*(\d+)\s*$/i,
        new RegExp(`\\((\\d+)\\)\\s*(${stepKeyword}\\b.*?)\\s*$`, 'i'),
        /^\s*(\d+)\s*[\)\.]\s*(?:Шаг|Step)\s*:\s*(.*?)\s*$/i,
        new RegExp(`^\\s*(\\d+)\\s*[\\)\\.]\\s*(${stepKeyword}\\b.*?)\\s*$`, 'i')
    ];
    const match = patterns.map(pattern => line.match(pattern)).find(Boolean);
    if (!match?.[1]) {
        return undefined;
    }

    const lineNumber = Number(match[1]);
    if (!Number.isFinite(lineNumber) || lineNumber <= 0) {
        return undefined;
    }

    const stepText = match[2]?.trim();
    return {
        lineNumber: Math.floor(lineNumber),
        stepText: stepText || undefined
    };
}

export function extractFeatureLineNumberFromRunLogLine(line: string): number | undefined {
    return extractRunLogStep(line)?.lineNumber;
}

function normalizeStepText(value: string): string {
    return value
        .trim()
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase();
}

function extractFeatureStepText(line: string): string | undefined {
    const match = line.match(/^\s*((?:Given|When|Then|And|But|Но|Тогда|Когда|Если|И|К\s+тому\s+же|Допустим|Дано|Пусть)\b.*?)\s*$/i);
    return match?.[1]?.trim() || undefined;
}

export function isRunLogStepCompatibleWithFeatureLine(logLine: string, featureLine: string): boolean {
    const logStepText = extractRunLogStep(logLine)?.stepText;
    if (!logStepText) {
        return true;
    }
    const featureStepText = extractFeatureStepText(featureLine);
    if (!featureStepText) {
        return false;
    }
    return normalizeStepText(logStepText) === normalizeStepText(featureStepText);
}

export function extractScenarioNameFromRunLogLine(line: string): string | undefined {
    const match = line.match(/^\s*(?:Сценарий|Scenario|ИмяСценария|ScenarioName)\s*:\s*(.+?)\s*$/i);
    if (!match?.[1]) {
        return undefined;
    }

    const scenarioName = stripWrappingQuotes(match[1]);
    return scenarioName.length > 0 ? scenarioName : undefined;
}

export function areScenarioNamesEqual(left: string | undefined, right: string | undefined): boolean {
    if (!left || !right) {
        return false;
    }
    return stripWrappingQuotes(left).trim().toLowerCase() === stripWrappingQuotes(right).trim().toLowerCase();
}

function isRunLogLineForScenario(
    normalizedScenarioName: string | undefined,
    currentScenarioNameFromLog: string | undefined,
    hasScenarioMarkers: boolean
): boolean {
    if (!normalizedScenarioName) {
        return true;
    }
    if (currentScenarioNameFromLog) {
        return areScenarioNamesEqual(currentScenarioNameFromLog, normalizedScenarioName);
    }
    return !hasScenarioMarkers;
}

function isFailedStepLogLine(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) {
        return false;
    }
    if (/^Failed:\s*/i.test(trimmed)) {
        return true;
    }
    return /^(?:Шаг|Step)\s*\(.+?\)\s*(?:не\s+выполнен|failed|is\s+not\s+executed|was\s+not\s+executed)/i.test(trimmed);
}

export function extractFailedSummaryFromLogLine(
    line: string
): { failedCount?: number; summaryLine: string } | null {
    const trimmed = line.trim();
    if (!/^Failed:\s*/i.test(trimmed)) {
        return null;
    }

    const valuePart = trimmed.replace(/^Failed:\s*/i, '').trim();
    const countMatch = valuePart.match(/-?\d+/);
    if (!countMatch) {
        return { summaryLine: trimmed };
    }

    const count = Number(countMatch[0]);
    if (!Number.isFinite(count)) {
        return { summaryLine: trimmed };
    }

    return {
        failedCount: Math.floor(count),
        summaryLine: trimmed
    };
}

function collectFailedStepLogBlock(lines: string[], startIndex: number): string[] {
    const block: string[] = [];
    const maxLines = 400;

    for (let index = startIndex; index < lines.length && block.length < maxLines; index++) {
        const rawLine = lines[index];
        const line = rawLine.replace(/\t/g, '    ').trimEnd();
        const trimmed = line.trim();

        if (index > startIndex) {
            const isNewStepEntry = extractRunLogStep(trimmed) !== undefined;
            const isFeatureHeader = /^\s*(?:Фича|Feature)\s*:/i.test(trimmed);
            const isScenarioHeader = /^\s*(?:Сценарий|Scenario)\s*:/i.test(trimmed);
            if (isNewStepEntry || isFeatureHeader || isScenarioHeader) {
                break;
            }
        }

        block.push(line);
        if (/^\s*ErrorFileJson\s*:/i.test(trimmed)) {
            break;
        }
    }

    while (block.length > 0 && block[block.length - 1].trim().length === 0) {
        block.pop();
    }
    return block;
}

function formatFailedStepSummaryFromLogBlock(block: string[]): string | undefined {
    if (!block.length) {
        return undefined;
    }
    const failedLine = block.find(line => /^Failed:\s*/i.test(line.trim()))?.trim();
    if (failedLine) {
        return failedLine;
    }

    const failedStepLine = block.find(line => /^(?:Шаг|Step)\s*\(.+?\)\s*(?:не\s+выполнен|failed|is\s+not\s+executed|was\s+not\s+executed)/i.test(line.trim()))?.trim();
    if (failedStepLine) {
        return failedStepLine;
    }

    return block.find(line => line.trim().length > 0)?.trim();
}

function formatFailedStepDetailsFromLogBlock(block: string[]): string | undefined {
    if (!block.length) {
        return undefined;
    }

    const stepLogLineRegex = /^\s*\d{1,2}\/\d{1,2}\/\d{4}.*\(\d+\)\s*\.?\s*(?:Шаг|Step)\s*:/i;
    const failedStepLineRegex = /^(?:Шаг|Step)\s*\(.+?\)\s*(?:не\s+выполнен|failed|is\s+not\s+executed|was\s+not\s+executed)/i;
    const failedLineRegex = /^Failed:\s*/i;

    const filtered: string[] = [];
    let previousNonEmptyTrimmed: string | undefined;

    for (const line of block) {
        const trimmed = line.trim();
        if (stepLogLineRegex.test(trimmed) || failedStepLineRegex.test(trimmed) || failedLineRegex.test(trimmed)) {
            continue;
        }

        if (!trimmed) {
            if (filtered.length > 0 && filtered[filtered.length - 1].trim().length > 0) {
                filtered.push('');
            }
            continue;
        }

        if (trimmed === previousNonEmptyTrimmed) {
            continue;
        }

        filtered.push(line);
        previousNonEmptyTrimmed = trimmed;
    }

    while (filtered.length > 0 && filtered[0].trim().length === 0) {
        filtered.shift();
    }
    while (filtered.length > 0 && filtered[filtered.length - 1].trim().length === 0) {
        filtered.pop();
    }

    const details = filtered.join('\n').trim();
    return details.length > 0 ? details : undefined;
}

function formatFailedStepDescriptionFromLogBlock(block: string[]): string | undefined {
    if (!block.length) {
        return undefined;
    }

    const failedStepLineRegex = /^(?:Шаг|Step)\s*\((.+?)\)\s*(?:не\s+выполнен|failed|is\s+not\s+executed|was\s+not\s+executed)/i;
    const stepLogLineRegex = /^\s*\d{1,2}\/\d{1,2}\/\d{4}.*\(\d+\)\s*\.?\s*(?:Шаг|Step)\s*:\s*(.+)$/i;

    for (const line of block) {
        const failedStepMatch = line.trim().match(failedStepLineRegex);
        const description = failedStepMatch?.[1]?.trim();
        if (description) {
            return description;
        }
    }

    for (const line of block) {
        const stepLogMatch = line.trim().match(stepLogLineRegex);
        const description = stepLogMatch?.[1]?.trim();
        if (description) {
            return description;
        }
    }

    return undefined;
}

export function extractFailedStepDetails(
    content: string,
    options: VanessaRunLogParseOptions = {}
): VanessaFailureDetails | null {
    const lines = content.split(/\r\n|\r|\n/);
    const normalizedScenarioName = options.scenarioName?.trim();
    let currentScenarioNameFromLog: string | undefined;
    let hasScenarioMarkers = false;
    let latestFailureBlock: string[] = [];

    for (let index = 0; index < lines.length; index++) {
        const scenarioNameFromLine = extractScenarioNameFromRunLogLine(lines[index]);
        if (scenarioNameFromLine) {
            hasScenarioMarkers = true;
            currentScenarioNameFromLog = scenarioNameFromLine;
        }

        if (!isRunLogLineForScenario(normalizedScenarioName, currentScenarioNameFromLog, hasScenarioMarkers)) {
            continue;
        }

        if (isFailedStepLogLine(lines[index])) {
            latestFailureBlock = collectFailedStepLogBlock(lines, index);
        }
    }

    if (!latestFailureBlock.length) {
        return null;
    }

    return {
        failureSummary: formatFailedStepSummaryFromLogBlock(latestFailureBlock),
        failureDetails: formatFailedStepDetailsFromLogBlock(latestFailureBlock),
        failureStepDescription: formatFailedStepDescriptionFromLogBlock(latestFailureBlock)
    };
}

export function extractLastStepLocation(
    content: string,
    options: VanessaRunLogParseOptions = {}
): VanessaStepLocation | null {
    const lines = content.split(/\r\n|\r|\n/);
    const normalizedScenarioName = options.scenarioName?.trim();
    let featurePath: string | undefined;
    let featureLineNumber: number | undefined;
    let currentFeaturePathFromLog: string | undefined;
    let currentScenarioNameFromLog: string | undefined;
    let currentScenarioFeaturePathFromLog: string | undefined;
    let hasScenarioMarkers = false;
    let iteration: number | undefined;
    const featureLines = options.featureContent?.split(/\r\n|\r|\n/);
    const lineVisits = new Map<number, number>();

    for (const line of lines) {
        const pathFromLine = extractFeaturePathFromRunLogLine(line);
        if (pathFromLine) {
            currentFeaturePathFromLog = pathFromLine;
            if (!normalizedScenarioName) {
                featurePath = pathFromLine;
            }
        }

        const scenarioNameFromLine = extractScenarioNameFromRunLogLine(line);
        if (scenarioNameFromLine) {
            hasScenarioMarkers = true;
            currentScenarioNameFromLog = scenarioNameFromLine;
            currentScenarioFeaturePathFromLog = currentFeaturePathFromLog;
        }

        const lineNumber = extractFeatureLineNumberFromRunLogLine(line);
        if (!lineNumber
            || !isRunLogLineForScenario(normalizedScenarioName, currentScenarioNameFromLog, hasScenarioMarkers)) {
            continue;
        }
        if (featureLines) {
            const featureLine = featureLines[lineNumber - 1];
            if (featureLine === undefined || !isRunLogStepCompatibleWithFeatureLine(line, featureLine)) {
                continue;
            }
        }

        if (normalizedScenarioName) {
            featurePath = currentScenarioFeaturePathFromLog || currentFeaturePathFromLog;
        }
        featureLineNumber = lineNumber;
        const visitCount = (lineVisits.get(lineNumber) || 0) + 1;
        lineVisits.set(lineNumber, visitCount);
        iteration = visitCount > 1 ? visitCount : undefined;
    }

    if (!featureLineNumber) {
        return null;
    }

    return {
        featurePath,
        featureLineNumber,
        ...(iteration ? { iteration } : {})
    };
}
