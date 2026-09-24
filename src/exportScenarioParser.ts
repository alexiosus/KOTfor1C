import {
    createLocalDefinitionId,
    normalizeProjectDefinitionTemplate,
    type ProjectDefinition,
    type ProjectDefinitionParameter,
    type ProjectDefinitionRange,
    type ProjectDefinitionWarning
} from './projectDefinition';
import {
    getGherkinDefinitionKeywords,
    type GherkinDefinitionKeywords,
    type ScenarioLanguage
} from './gherkinDefinitionKeywords';

export interface ExportScenarioParseContext {
    readonly sourceUri: string;
    readonly workspaceFolderUri: string;
    readonly profileId: string;
    readonly libraryRootUri: string;
    readonly sourceLabel: string;
    readonly defaultLanguage: ScenarioLanguage;
}

export interface ExportFeatureMetadata {
    readonly title: string;
    readonly tags: readonly string[];
    readonly hasExportTag: boolean;
    readonly declarationRange: ProjectDefinitionRange;
    readonly tagInsertion: { readonly offset: number; readonly line: number; readonly character: number };
}

export interface ExportScenarioDeclaration {
    readonly title: string;
    readonly tags: readonly string[];
    readonly exported: boolean;
    readonly titleRange: ProjectDefinitionRange;
    readonly declarationRange: ProjectDefinitionRange;
    readonly description: string;
    readonly metadata: ExportScenarioMetadata;
    readonly metadataInsertion: { readonly offset: number; readonly line: number; readonly character: number };
    readonly definitionId?: string;
}

export interface ExportScenarioParseResult {
    readonly definitions: readonly ProjectDefinition[];
    readonly scenarios: readonly ExportScenarioDeclaration[];
    readonly warnings: readonly ProjectDefinitionWarning[];
    readonly language: ScenarioLanguage;
    readonly eol: '\n' | '\r\n';
    readonly hasBom: boolean;
    readonly feature: ExportFeatureMetadata | null;
    readonly insertion: {
        readonly offset: number;
        readonly line: number;
        readonly character: number;
        readonly endsWithEol: boolean;
    };
}

interface SourceLine {
    readonly number: number;
    readonly text: string;
    readonly start: number;
    readonly end: number;
    readonly fullEnd: number;
}

interface MutableScenario {
    readonly title: string;
    readonly tags: string[];
    readonly exported: boolean;
    readonly titleRange: ProjectDefinitionRange;
    readonly declarationStart: number;
    readonly parameters: readonly ProjectDefinitionParameter[];
    category?: string;
    usageExample?: string;
    descriptionLines: string[];
    explicitDescription?: string;
    bodyStarted: boolean;
}

export interface ExportScenarioMetadata {
    readonly category?: string;
    readonly description?: string;
    readonly usageExample?: string;
}

type DeclarationKind = 'feature' | 'scenario' | 'outline' | 'background' | 'examples';

interface DeclarationMatch {
    readonly kind: DeclarationKind;
    readonly title: string;
    readonly titleStart: number;
    readonly titleEnd: number;
}

const LANGUAGE_DIRECTIVE = /^#\s*language\s*:\s*(ru|en)\b/iu;
const EXPORT_TAG = '@exportscenarios';

function parseScenarioMetadata(value: string): ExportScenarioMetadata | null {
    const separator = value.indexOf(':');
    if (separator < 0) {
        return null;
    }
    const tag = value.slice(0, separator).trim().toLocaleLowerCase();
    const metadataValue = value.slice(separator + 1).trim();
    switch (tag) {
        case '@steptype':
        case '@типшага':
            return { category: metadataValue };
        case '@description':
        case '@описание':
            return { description: metadataValue };
        case '@exampleofuse':
        case '@примериспользования':
            return { usageExample: metadataValue };
        default:
            return null;
    }
}

function readLines(source: string): SourceLine[] {
    const lines: SourceLine[] = [];
    let start = 0;
    let number = 0;
    while (start < source.length) {
        const newline = source.indexOf('\n', start);
        const fullEnd = newline >= 0 ? newline + 1 : source.length;
        const rawEnd = newline >= 0 ? newline : source.length;
        const end = rawEnd > start && source[rawEnd - 1] === '\r' ? rawEnd - 1 : rawEnd;
        lines.push({ number, text: source.slice(start, end), start, end, fullEnd });
        start = fullEnd;
        number += 1;
    }
    if (source.length === 0 || source.endsWith('\n')) {
        lines.push({ number, text: '', start: source.length, end: source.length, fullEnd: source.length });
    }
    return lines;
}

function positionAtOffset(source: string, offset: number): { line: number; character: number } {
    let line = 0;
    let lineStart = 0;
    for (let index = 0; index < offset; index++) {
        if (source[index] === '\n') {
            line += 1;
            lineStart = index + 1;
        }
    }
    return { line, character: offset - lineStart };
}

function rangeForLine(line: SourceLine, startCharacter: number, endCharacter: number): ProjectDefinitionRange {
    return {
        start: { line: line.number, character: startCharacter },
        end: { line: line.number, character: endCharacter }
    };
}

function parseTags(value: string): string[] {
    return value
        .split(/\s+/u)
        .map(tag => tag.trim())
        .filter(tag => tag.startsWith('@'));
}

function hasExportTag(tags: readonly string[]): boolean {
    return tags.some(tag => tag.toLocaleLowerCase() === EXPORT_TAG);
}

function keywordKind(prefix: string, keywords: GherkinDefinitionKeywords): DeclarationKind | null {
    const normalized = prefix.trim().toLocaleLowerCase();
    const has = (values: readonly string[]) => values.some(value => value.toLocaleLowerCase() === normalized);
    if (has(keywords.feature)) {
        return 'feature';
    }
    if (has(keywords.outline)) {
        return 'outline';
    }
    if (has(keywords.scenario)) {
        return 'scenario';
    }
    if (has(keywords.background)) {
        return 'background';
    }
    if (has(keywords.examples)) {
        return 'examples';
    }
    return null;
}

function matchDeclaration(line: SourceLine, keywords: GherkinDefinitionKeywords): DeclarationMatch | null {
    const sourceText = line.number === 0 ? line.text.replace(/^\uFEFF/u, '') : line.text;
    const bomShift = line.number === 0 && line.text.startsWith('\uFEFF') ? 1 : 0;
    const colon = sourceText.indexOf(':');
    if (colon < 0) {
        return null;
    }
    const kind = keywordKind(sourceText.slice(0, colon), keywords);
    if (!kind) {
        return null;
    }

    let titleStart = colon + 1;
    while (titleStart < sourceText.length && /\s/u.test(sourceText[titleStart])) {
        titleStart += 1;
    }
    let titleEnd = sourceText.length;
    while (titleEnd > titleStart && /\s/u.test(sourceText[titleEnd - 1])) {
        titleEnd -= 1;
    }
    return {
        kind,
        title: sourceText.slice(titleStart, titleEnd),
        titleStart: titleStart + bomShift,
        titleEnd: titleEnd + bomShift
    };
}

function isStepLine(value: string, keywords: GherkinDefinitionKeywords): boolean {
    const withoutBullet = value.replace(/^\*\s*/u, '');
    const normalized = withoutBullet.toLocaleLowerCase();
    return keywords.steps.some(keyword => {
        const candidate = keyword.toLocaleLowerCase();
        return normalized === candidate || normalized.startsWith(`${candidate} `);
    });
}

function extractParameters(title: string): readonly ProjectDefinitionParameter[] {
    const discovered: Array<{ offset: number; name: string; source: 'quoted' | 'outline' }> = [];
    for (let index = 0; index < title.length; index++) {
        const token = title[index];
        if (token === '"' || token === "'") {
            let end = index + 1;
            while (end < title.length) {
                if (title[end] === token && title[end - 1] !== '\\') {
                    break;
                }
                end += 1;
            }
            if (end < title.length) {
                const rawName = title.slice(index + 1, end).trim().replace(/^%\d+\s*/u, '');
                discovered.push({
                    offset: index,
                    name: rawName || `Parameter${discovered.length + 1}`,
                    source: 'quoted'
                });
                index = end;
            }
            continue;
        }
        if (token === '<') {
            const end = title.indexOf('>', index + 1);
            if (end > index + 1) {
                discovered.push({
                    offset: index,
                    name: title.slice(index + 1, end).trim(),
                    source: 'outline'
                });
                index = end;
            }
        }
    }
    return Object.freeze(discovered
        .filter(parameter => parameter.name.length > 0)
        .sort((left, right) => left.offset - right.offset)
        .map((parameter, index) => Object.freeze({
            name: parameter.name,
            index,
            source: parameter.source
        })));
}

export function parseExportScenarios(
    source: string,
    context: ExportScenarioParseContext
): ExportScenarioParseResult {
    const lines = readLines(source);
    const hasBom = source.startsWith('\uFEFF');
    const eol: '\n' | '\r\n' = source.includes('\r\n') ? '\r\n' : '\n';
    let language = context.defaultLanguage;
    let keywords = getGherkinDefinitionKeywords(language);
    let pendingTags: string[] = [];
    let pendingScenarioMetadata: ExportScenarioMetadata = {};
    let feature: ExportFeatureMetadata | null = null;
    let current: MutableScenario | null = null;
    let docStringDelimiter: '"""' | '```' | null = null;
    const definitions: ProjectDefinition[] = [];
    const scenarios: ExportScenarioDeclaration[] = [];
    const warnings: ProjectDefinitionWarning[] = [];

    const finalizeScenario = (endOffset: number): void => {
        if (!current) {
            return;
        }
        const description = (current.explicitDescription ?? current.descriptionLines.join('\n')).trim();
        let definition: ProjectDefinition | undefined;
        if (current.exported) {
            const template = current.title;
            const id = createLocalDefinitionId({
                kind: 'exportScenario',
                sourceUri: context.sourceUri,
                range: current.titleRange,
                signature: template
            });
            definition = Object.freeze({
                id,
                kind: 'exportScenario',
                template,
                normalizedTemplate: normalizeProjectDefinitionTemplate(template),
                language,
                parameters: current.parameters,
                description: description || undefined,
                category: current.category || undefined,
                usageExample: current.usageExample || undefined,
                sourceLabel: context.sourceLabel,
                workspaceFolderUri: context.workspaceFolderUri,
                profileId: context.profileId,
                libraryRootUri: context.libraryRootUri,
                definitionLocation: {
                    uri: context.sourceUri,
                    range: current.titleRange
                }
            });
            definitions.push(definition);
        }
        scenarios.push(Object.freeze({
            title: current.title,
            tags: Object.freeze(current.tags.slice()),
            exported: current.exported,
            titleRange: current.titleRange,
            declarationRange: {
                start: positionAtOffset(source, current.declarationStart),
                end: positionAtOffset(source, endOffset)
            },
            description,
            metadata: Object.freeze({
                category: current.category,
                description: current.explicitDescription,
                usageExample: current.usageExample
            }),
            metadataInsertion: Object.freeze({
                offset: current.declarationStart,
                ...positionAtOffset(source, current.declarationStart)
            }),
            definitionId: definition?.id
        }));
        current = null;
    };

    for (const line of lines) {
        const rawTrimmed = line.text.trim();
        const trimmed = line.number === 0 ? rawTrimmed.replace(/^\uFEFF/u, '') : rawTrimmed;

        if (docStringDelimiter) {
            if (trimmed.startsWith(docStringDelimiter)) {
                docStringDelimiter = null;
            }
            continue;
        }
        if (trimmed.startsWith('"""') || trimmed.startsWith('```')) {
            docStringDelimiter = trimmed.startsWith('"""') ? '"""' : '```';
            if (current) {
                current.bodyStarted = true;
            }
            pendingTags = [];
            continue;
        }

        const languageMatch = LANGUAGE_DIRECTIVE.exec(trimmed);
        if (languageMatch) {
            language = languageMatch[1].toLocaleLowerCase() as ScenarioLanguage;
            keywords = getGherkinDefinitionKeywords(language);
            continue;
        }
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
            continue;
        }
        if (trimmed.startsWith('@')) {
            const metadata = parseScenarioMetadata(trimmed);
            if (metadata) {
                if (current && !current.bodyStarted) {
                    current.category = metadata.category ?? current.category;
                    current.explicitDescription = metadata.description ?? current.explicitDescription;
                    current.usageExample = metadata.usageExample ?? current.usageExample;
                } else {
                    pendingScenarioMetadata = {
                        ...pendingScenarioMetadata,
                        ...metadata
                    };
                }
                continue;
            }
            pendingTags.push(...parseTags(trimmed));
            continue;
        }

        const declaration = matchDeclaration(line, keywords);
        if (declaration?.kind === 'feature') {
            finalizeScenario(line.start);
            const tags = Object.freeze(pendingTags.slice());
            pendingTags = [];
            pendingScenarioMetadata = {};
            feature = Object.freeze({
                title: declaration.title,
                tags,
                hasExportTag: hasExportTag(tags),
                declarationRange: rangeForLine(line, 0, line.text.length),
                tagInsertion: { offset: line.start, line: line.number, character: 0 }
            });
            if (!declaration.title) {
                warnings.push({
                    uri: context.sourceUri,
                    message: 'Feature declaration has an empty title.',
                    range: rangeForLine(line, 0, line.text.length)
                });
            }
            continue;
        }
        if (declaration?.kind === 'scenario' || declaration?.kind === 'outline') {
            finalizeScenario(line.start);
            const tags = pendingTags.slice();
            pendingTags = [];
            if (!declaration.title) {
                warnings.push({
                    uri: context.sourceUri,
                    message: 'Export feature contains an empty scenario title.',
                    range: rangeForLine(line, 0, line.text.length)
                });
                continue;
            }
            current = {
                title: declaration.title,
                tags,
                exported: (feature?.hasExportTag ?? false) || hasExportTag(tags),
                titleRange: rangeForLine(line, declaration.titleStart, declaration.titleEnd),
                declarationStart: line.start,
                parameters: extractParameters(declaration.title),
                category: pendingScenarioMetadata.category,
                explicitDescription: pendingScenarioMetadata.description,
                usageExample: pendingScenarioMetadata.usageExample,
                descriptionLines: [],
                bodyStarted: false
            };
            pendingScenarioMetadata = {};
            continue;
        }
        if (declaration?.kind === 'background') {
            finalizeScenario(line.start);
            pendingTags = [];
            pendingScenarioMetadata = {};
            continue;
        }
        if (declaration?.kind === 'examples') {
            if (current) {
                current.bodyStarted = true;
            }
            pendingTags = [];
            pendingScenarioMetadata = {};
            continue;
        }

        if (current) {
            if (isStepLine(trimmed, keywords) || trimmed.startsWith('|')) {
                current.bodyStarted = true;
            } else if (!current.bodyStarted) {
                current.descriptionLines.push(trimmed);
            }
        }
        pendingTags = [];
    }

    finalizeScenario(source.length);
    const insertionPosition = positionAtOffset(source, source.length);
    return Object.freeze({
        definitions: Object.freeze(definitions),
        scenarios: Object.freeze(scenarios),
        warnings: Object.freeze(warnings),
        language,
        eol,
        hasBom,
        feature,
        insertion: Object.freeze({
            offset: source.length,
            line: insertionPosition.line,
            character: insertionPosition.character,
            endsWithEol: source.endsWith('\n') || source.endsWith('\r')
        })
    });
}
