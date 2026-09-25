import { HTMLElement, parse } from 'node-html-parser';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
    BuiltInStepCatalog,
    BuiltInStepDefinition,
    createStepDefinitionId,
    executableStepDefinitions,
    isStepCategoryDefinition,
    normalizeStepCatalogText,
    parseBuiltInStepCatalog,
    parseStepCatalogIndex,
    sha256Hex,
    StepCatalogIndex,
    StepTextVariant
} from './stepCatalog';
import { parseLegacyStepsHtml } from './legacyStepCatalog';

const SPREADSHEET_NAMESPACE = 'http://v8.1c.ru/8.2/data/spreadsheet';
const CORE_NAMESPACE = 'http://v8.1c.ru/8.1/data/core';
const EXPECTED_HEADER = [
    'Шаг оригинал',
    'Описание',
    'Перевод шага',
    'Перевод описания'
] as const;
const RUSSIAN_SYNTAX_DESCRIPTION = 'Специальный текст';
const ENGLISH_SYNTAX_DESCRIPTION = 'Special text';
const MINIMUM_PRECEDING_STEP_RATIO = 0.9;

export interface VanessaTemplateParseResult {
    readonly steps: readonly BuiltInStepDefinition[];
    readonly categories: readonly StepCategoryTranslation[];
    readonly sourceRows: number;
    readonly excludedSyntaxRows: number;
}

export interface StepCategoryTranslation {
    readonly ru?: string;
    readonly en?: string;
}

export interface GenerateCatalogOptions {
    readonly version: string;
    readonly sourceRef: string;
    readonly sourceCommit: string;
    readonly sourceTimestamp: string;
}

export interface StepCatalogCompatibilityReport {
    readonly missingLegacyRuPatterns: readonly string[];
    readonly missingLegacyEnPatterns: readonly string[];
}

export interface StepCatalogGenerationReport extends StepCatalogCompatibilityReport {
    readonly schemaVersion: 1;
    readonly vanessaVersion: string;
    readonly sourceRows: number;
    readonly excludedSyntaxRows: number;
    readonly categoryCount: number;
    readonly stepCount: number;
    readonly russianStepCount: number;
    readonly englishStepCount: number;
    readonly duplicateStepIds: readonly string[];
    readonly duplicateRussianPatterns: readonly string[];
    readonly duplicateEnglishPatterns: readonly string[];
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: Iterable<string>): string[] {
    return [...new Set(values)].sort(compareText);
}

function duplicateValues(values: Iterable<string>): string[] {
    const counts = new Map<string, number>();
    for (const value of values) {
        counts.set(value, (counts.get(value) || 0) + 1);
    }
    return [...counts.entries()]
        .filter(([, count]) => count > 1)
        .map(([value]) => value)
        .sort(compareText);
}

function serializeJson(value: unknown): string {
    return `${JSON.stringify(value, null, 2)}\n`;
}

function descendantsByTag(element: HTMLElement | undefined, rawTagName: string): HTMLElement[] {
    if (!element) {
        return [];
    }
    return element.querySelectorAll('*').filter(candidate => candidate.rawTagName === rawTagName);
}

function directChildrenByTag(element: HTMLElement, rawTagName: string): HTMLElement[] {
    return element.childNodes.filter(
        (candidate): candidate is HTMLElement => candidate instanceof HTMLElement
            && candidate.rawTagName === rawTagName
    );
}

function localizedCellText(cell: HTMLElement): string {
    const localizedItems = descendantsByTag(cell, 'v8:item');
    const russianItem = localizedItems.find(item => {
        const language = descendantsByTag(item, 'v8:lang')[0];
        return normalizeStepCatalogText(language?.textContent || '') === 'ru';
    });
    const selectedItem = russianItem || localizedItems[0];
    const content = descendantsByTag(selectedItem, 'v8:content')[0];
    return normalizeStepCatalogText(content?.textContent || '');
}

function readRowCells(rowsItem: HTMLElement, rowIndex: number): readonly string[] {
    const row = directChildrenByTag(rowsItem, 'row')[0];
    if (!row) {
        throw new Error(`Vanessa template row ${rowIndex} does not contain a row element.`);
    }
    const cells = directChildrenByTag(row, 'c');
    if (cells.length !== 4) {
        throw new Error(
            `Vanessa template row ${rowIndex} must contain exactly four cells; found ${cells.length}.`
        );
    }
    return cells.map(localizedCellText);
}

function createVariant(pattern: string, description: string): StepTextVariant | undefined {
    if (!pattern) {
        return undefined;
    }
    return { pattern, description };
}

function validatePatternPlaceholders(pattern: string, language: 'ru' | 'en'): void {
    for (const match of pattern.matchAll(/%(\d+)/g)) {
        const digits = match[1];
        const placeholderIndex = match.index;
        if (placeholderIndex === undefined) {
            continue;
        }
        if (digits.startsWith('0') || Number(digits) < 1) {
            throw new Error(
                `Step pattern (${language}) contains an invalid placeholder number: %${digits}.`
            );
        }
        const afterDigits = placeholderIndex + match[0].length;
        if (!/\s/.test(pattern[afterDigits] || '')) {
            throw new Error(
                `Step pattern (${language}) contains an invalid placeholder without a hint separator: %${digits}.`
            );
        }

        const lineStart = pattern.lastIndexOf('\n', placeholderIndex) + 1;
        const lineEndCandidate = pattern.indexOf('\n', afterDigits);
        const lineEnd = lineEndCandidate === -1 ? pattern.length : lineEndCandidate;
        const before = pattern.slice(lineStart, placeholderIndex);
        const openingQuote = before.match(/(["'])\s*$/)?.[1];
        if (!openingQuote || pattern.indexOf(openingQuote, afterDigits) >= lineEnd) {
            throw new Error(
                `Step pattern (${language}) contains an invalid placeholder outside matching quotes: %${digits}.`
            );
        }
    }
}

function compareVersions(left: string, right: string): number {
    const leftParts = left.split('.').map(Number);
    const rightParts = right.split('.').map(Number);
    for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index++) {
        const difference = (leftParts[index] || 0) - (rightParts[index] || 0);
        if (difference !== 0) {
            return difference;
        }
    }
    return 0;
}

export function parseVanessaStepTemplateXml(xml: string): VanessaTemplateParseResult {
    const root = parse(xml);
    const document = root.querySelector('document');
    if (
        !document
        || document.getAttribute('xmlns') !== SPREADSHEET_NAMESPACE
        || document.getAttribute('xmlns:v8') !== CORE_NAMESPACE
    ) {
        throw new Error('Vanessa template namespace does not match the expected 1C spreadsheet schema.');
    }

    // node-html-parser preserves raw XML tag casing, but its selector engine lowercases queries.
    const rowsItems = root.querySelectorAll('rowsitem').filter(item => item.rawTagName === 'rowsItem');
    if (rowsItems.length < 2) {
        throw new Error('Vanessa template header or data rows are missing.');
    }

    const header = readRowCells(rowsItems[0], 0);
    if (!EXPECTED_HEADER.every((label, index) => header[index] === label)) {
        throw new Error(
            `Vanessa template header must be exactly: ${EXPECTED_HEADER.join(' | ')}.`
        );
    }

    const steps: BuiltInStepDefinition[] = [];
    const categories: StepCategoryTranslation[] = [];
    let excludedSyntaxRows = 0;
    for (let index = 1; index < rowsItems.length; index++) {
        const [russianPattern, russianDescription, englishPattern, englishDescription]
            = readRowCells(rowsItems[index], index);
        if (
            russianDescription === RUSSIAN_SYNTAX_DESCRIPTION
            && englishDescription === ENGLISH_SYNTAX_DESCRIPTION
        ) {
            excludedSyntaxRows++;
            continue;
        }

        const ru = createVariant(russianPattern, russianDescription);
        const en = createVariant(englishPattern, englishDescription);
        if (!ru && !en) {
            throw new Error(`Vanessa template row ${index} has no Russian or English step pattern.`);
        }
        if (isStepCategoryDefinition({ ru, en })) {
            categories.push({
                ...(ru ? { ru: ru.pattern } : {}),
                ...(en ? { en: en.pattern } : {})
            });
            continue;
        }
        steps.push({
            id: createStepDefinitionId(ru?.pattern, en?.pattern),
            ru,
            en
        });
    }

    return {
        steps,
        categories,
        sourceRows: rowsItems.length - 1,
        excludedSyntaxRows
    };
}

export function generateBuiltInStepCatalog(
    parsed: VanessaTemplateParseResult,
    options: GenerateCatalogOptions
): BuiltInStepCatalog {
    for (const step of parsed.steps) {
        if (step.ru) {
            validatePatternPlaceholders(step.ru.pattern, 'ru');
        }
        if (step.en) {
            validatePatternPlaceholders(step.en.pattern, 'en');
        }
    }
    const steps = [...parsed.steps].sort((left, right) => {
        return compareText(left.ru?.pattern || '', right.ru?.pattern || '')
            || compareText(left.en?.pattern || '', right.en?.pattern || '')
            || compareText(left.id, right.id);
    });
    return parseBuiltInStepCatalog({
        schemaVersion: 1,
        vanessaVersion: options.version,
        generatedAt: options.sourceTimestamp,
        source: {
            repository: 'Pr-Mex/vanessa-automation',
            ref: options.sourceRef,
            commit: options.sourceCommit
        },
        steps
    });
}

export function serializeStepCatalogJson(catalog: BuiltInStepCatalog): string {
    return serializeJson(catalog);
}

export function compareCatalogWithLegacyHtml(
    catalog: BuiltInStepCatalog,
    legacyHtml: string
): StepCatalogCompatibilityReport {
    const generatedRussian = new Set(
        catalog.steps.flatMap(step => step.ru ? [normalizeStepCatalogText(step.ru.pattern)] : [])
    );
    const generatedEnglish = new Set(
        catalog.steps.flatMap(step => step.en ? [normalizeStepCatalogText(step.en.pattern)] : [])
    );
    const legacy = parseLegacyStepsHtml(legacyHtml);
    return {
        missingLegacyRuPatterns: sortedUnique(
            legacy.flatMap(step => {
                const pattern = step.ru && normalizeStepCatalogText(step.ru.pattern);
                return pattern && !generatedRussian.has(pattern) ? [pattern] : [];
            })
        ),
        missingLegacyEnPatterns: sortedUnique(
            legacy.flatMap(step => {
                const pattern = step.en && normalizeStepCatalogText(step.en.pattern);
                return pattern && !generatedEnglish.has(pattern) ? [pattern] : [];
            })
        )
    };
}

export function createStepCatalogGenerationReport(
    parsed: VanessaTemplateParseResult,
    catalog: BuiltInStepCatalog,
    compatibility: StepCatalogCompatibilityReport
): StepCatalogGenerationReport {
    return {
        schemaVersion: 1,
        vanessaVersion: catalog.vanessaVersion,
        sourceRows: parsed.sourceRows,
        excludedSyntaxRows: parsed.excludedSyntaxRows,
        categoryCount: parsed.categories.length,
        stepCount: catalog.steps.length,
        russianStepCount: catalog.steps.filter(step => step.ru !== undefined).length,
        englishStepCount: catalog.steps.filter(step => step.en !== undefined).length,
        duplicateStepIds: duplicateValues(catalog.steps.map(step => step.id)),
        duplicateRussianPatterns: duplicateValues(
            catalog.steps.flatMap(step => step.ru ? [step.ru.pattern] : [])
        ),
        duplicateEnglishPatterns: duplicateValues(
            catalog.steps.flatMap(step => step.en ? [step.en.pattern] : [])
        ),
        missingLegacyRuPatterns: [...compatibility.missingLegacyRuPatterns],
        missingLegacyEnPatterns: [...compatibility.missingLegacyEnPatterns]
    };
}

async function readOptional(filePath: string): Promise<Buffer | null> {
    try {
        return await readFile(filePath);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}

function latestTimestamp(left: string | undefined, right: string): string {
    if (!left) {
        return right;
    }
    return Date.parse(left) >= Date.parse(right) ? left : right;
}

export async function writeCatalogPublication(
    publicationRoot: string,
    catalog: BuiltInStepCatalog,
    report: StepCatalogGenerationReport
): Promise<void> {
    const validatedCatalog = parseBuiltInStepCatalog(catalog, catalog.vanessaVersion);
    if (
        report.vanessaVersion !== validatedCatalog.vanessaVersion
        || report.stepCount !== validatedCatalog.steps.length
    ) {
        throw new Error('Generation report does not match the generated step catalog.');
    }

    const catalogText = serializeStepCatalogJson(validatedCatalog);
    const reportText = serializeJson(report);
    const indexPath = path.join(publicationRoot, 'index.json');
    const existingIndexBytes = await readOptional(indexPath);
    const existingIndex = existingIndexBytes
        ? parseStepCatalogIndex(JSON.parse(existingIndexBytes.toString('utf8')))
        : undefined;
    const precedingVersion = Object.keys(existingIndex?.catalogs || {})
        .filter(version => compareVersions(version, validatedCatalog.vanessaVersion) < 0)
        .sort(compareVersions)
        .at(-1);
    if (precedingVersion) {
        const precedingEntry = existingIndex!.catalogs[precedingVersion];
        const precedingCatalogBytes = await readOptional(
            path.join(publicationRoot, precedingEntry.path)
        );
        const precedingCount = precedingCatalogBytes
            ? executableStepDefinitions(parseBuiltInStepCatalog(
                JSON.parse(precedingCatalogBytes.toString('utf8')),
                precedingVersion
            ).steps).length
            : precedingEntry.stepCount;
        if (validatedCatalog.steps.length < precedingCount * MINIMUM_PRECEDING_STEP_RATIO) {
            throw new Error(
                `Refusing material step-count drop from ${precedingCount} in Vanessa `
                + `${precedingVersion} to ${validatedCatalog.steps.length} in `
                + `${validatedCatalog.vanessaVersion} (more than 10%).`
            );
        }
    }

    const versionDirectory = path.join(publicationRoot, validatedCatalog.vanessaVersion);
    const catalogPath = path.join(versionDirectory, 'catalog.json');
    const reportPath = path.join(versionDirectory, 'generation-report.json');
    const [existingCatalog, existingReport] = await Promise.all([
        readOptional(catalogPath),
        readOptional(reportPath)
    ]);
    if (existingCatalog && existingCatalog.toString('utf8') !== catalogText) {
        throw new Error(
            `An immutable catalog already exists for Vanessa ${validatedCatalog.vanessaVersion}.`
        );
    }
    if (existingReport && existingReport.toString('utf8') !== reportText) {
        throw new Error(
            `An immutable generation report already exists for Vanessa ${validatedCatalog.vanessaVersion}.`
        );
    }

    await mkdir(versionDirectory, { recursive: true });
    if (!existingReport) {
        await writeFile(reportPath, reportText, { flag: 'wx' });
    }
    if (!existingCatalog) {
        await writeFile(catalogPath, catalogText, { flag: 'wx' });
    }

    const catalogs = {
        ...existingIndex?.catalogs,
        [validatedCatalog.vanessaVersion]: {
            path: `${validatedCatalog.vanessaVersion}/catalog.json`,
            sha256: sha256Hex(catalogText),
            stepCount: validatedCatalog.steps.length,
            sourceCommit: validatedCatalog.source.commit
        }
    };
    const sortedCatalogs = Object.fromEntries(
        Object.entries(catalogs).sort(([left], [right]) => compareText(left, right))
    );
    const index: StepCatalogIndex = {
        schemaVersion: 1,
        generatedAt: latestTimestamp(existingIndex?.generatedAt, validatedCatalog.generatedAt),
        catalogs: sortedCatalogs
    };
    parseStepCatalogIndex(index);
    await writeFile(indexPath, serializeJson(index));
}
