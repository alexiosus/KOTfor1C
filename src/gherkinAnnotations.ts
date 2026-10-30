import { getGherkinDefinitionKeywords, type ScenarioLanguage } from './gherkinDefinitionKeywords';
import { ScenarioYamlDocument } from './scenarioYamlDocument';

export interface GherkinAnnotationSource {
    readonly text: string;
    readonly uri: string;
    readonly language: ScenarioLanguage;
}
export interface GherkinAnnotationCompletion {
    readonly label: string;
    readonly documentation: string;
    readonly start: number;
    readonly end: number;
    readonly insertText: string;
    readonly filterText: string;
    readonly snippet: boolean;
}
type Kind = 'feature' | 'scenario' | 'background' | 'other' | 'step' | 'group';
interface Line { number: number; text: string; start: number; kind?: Kind; payload: boolean }
interface Scan { lines: Line[]; yaml: boolean; blockLine: number; minimumIndent: number; language: ScenarioLanguage; eol: string }
interface Annotation { label: string; documentation: string; kinds: readonly Kind[]; field?: string; metadata?: string }
interface CompletionContext {
    subject: Line; atSubject: boolean; tokenStart: number; tokenEnd: number; token: string; tokenPrefix: string;
}

const STEP_TAGS = ['screenshot', 'recordvideo', 'StopRecordVideo', 'StartRecordVideo'] as const;
const STEP_KEYWORDS = [...getGherkinDefinitionKeywords('en').steps, ...getGherkinDefinitionKeywords('ru').steps, 'Do']
    .sort((left, right) => right.length - left.length);
const ANNOTATIONS: readonly Annotation[] = [
    { label: '@tree', documentation: 'Show steps as a hierarchy.', kinds: ['feature'] },
    { label: '@ExportScenarios', documentation: 'Make these scenarios available as exported steps.', kinds: ['feature', 'scenario'] },
    { label: '@Draft', documentation: 'Draft marker. Add Draft to ignoretags to exclude it from runs.', kinds: ['feature', 'scenario'] },
    { label: '@screenshot', documentation: 'Screenshots before and after the step; enable screenshots in Vanessa.', kinds: ['step', 'group'] },
    { label: '@recordvideo', documentation: 'Record from this step to the end; requires ffmpeg.', kinds: ['step', 'group'] },
    { label: '@StopRecordVideo', documentation: 'Stop a video fragment.', kinds: ['step', 'group'] },
    { label: '@StartRecordVideo', documentation: 'Start a video fragment.', kinds: ['step', 'group'] },
    { label: '#[autodoc.ignorestep]', documentation: 'Execute the step or group without including it in the instruction.', kinds: ['step', 'group'] },
    { label: '#[autodoc.mute]', documentation: 'Include the step or group without narration.', kinds: ['step', 'group'] },
    { label: '#[autodoc.donotscale]', documentation: 'Keep the original timing of the step or group.', kinds: ['step', 'group'] },
    { label: '#[autodoc.text]', documentation: 'Replace the instruction text for this step.', kinds: ['step', 'group'], field: 'Step text' },
    { label: '#[autodoc.groupsteps]', documentation: 'Represent the group as one instruction step with this text.', kinds: ['group'], field: 'Group text' },
    { label: '#[autodoc.ignore.featureslide]', documentation: 'Omit the feature title slide from the video instruction.', kinds: ['feature'] },
    { label: '#[autodoc.ignore.finalslide]', documentation: 'Omit the final slide from the video instruction.', kinds: ['feature'] },
    { label: '#[autodoc.ignore.scenarioslide]', documentation: 'Omit the scenario title slide from the video instruction.', kinds: ['scenario'] }
];
const METADATA = [
    { key: 'category', en: '@steptype:', ru: '@типшага:', documentation: 'Exported scenario category.', field: 'Category' },
    { key: 'description', en: '@description:', ru: '@описание:', documentation: 'Exported scenario description.', field: 'Description' },
    { key: 'example', en: '@exampleofuse:', ru: '@примериспользования:', documentation: 'Example of calling the exported scenario.', field: 'Usage example' }
] as const;

function escapeSnippet(text: string): string { return text.replace(/[\\$}]/gu, '\\$&'); }
function indent(line: Line): string { return /^[ \t]*/u.exec(line.text.replace(/^\uFEFF/u, ''))![0]; }
function contentStart(line: Line): number { return indent(line).length + (line.text.startsWith('\uFEFF') ? 1 : 0); }
function isAnnotation(text: string): boolean { return /^\s*(?:@|#|\/\/)/u.test(text); }
function annotationIds(text: string): string[] {
    return (text.match(/@[^\s@]+|#\[autodoc\.[\w.]+\]/giu) ?? []).map(value => value.toLocaleLowerCase());
}

function scan(source: GherkinAnnotationSource): Scan | undefined {
    const yaml = /\.ya?ml(?:[?#].*)?$/iu.test(source.uri);
    if (!yaml && !/\.feature(?:[?#].*)?$/iu.test(source.uri)) { return undefined; }
    const lines: Line[] = [];
    let offset = 0;
    for (const [number, text] of source.text.split(/\r\n|\r|\n/u).entries()) {
        lines.push({ number, text, start: offset, payload: false });
        offset += text.length + (source.text.slice(offset + text.length, offset + text.length + 2) === '\r\n' ? 2 : 1);
    }
    let blockLine = -1;
    let minimumIndent = 0;
    let allowed = lines;
    if (yaml) {
        const document = ScenarioYamlDocument.parse(source.text);
        const type = document.findFieldAtPath(['ТипФайла']);
        const field = document.findFieldAtPath(['ТекстСценария']);
        if (document.errors.length || type?.ambiguous || type?.value !== 'Сценарий' || field?.ambiguous || !field?.blockScalarContentRange) { return undefined; }
        blockLine = lines.findIndex(line => line.start === field.lineStart);
        const width = indent(lines[blockLine]).length;
        const nextField = lines.find(line => line.number > blockLine && line.text.trim() && indent(line).length <= width);
        allowed = lines.filter(line => line.number > blockLine && line.number < (nextField?.number ?? lines.length));
        const widths = allowed.filter(line => line.text.trim()).map(line => indent(line).length);
        minimumIndent = widths.length ? Math.min(...widths) : width + Number(/[|>]([1-9])/u.exec(lines[blockLine].text)?.[1] ?? 2);
    }
    let delimiter = '';
    let language = source.language;
    const keywords = [getGherkinDefinitionKeywords('en'), getGherkinDefinitionKeywords('ru')];
    for (const line of allowed) {
        const text = line.text.replace(/^\uFEFF/u, '').trim();
        const marker = /^("""|```)/u.exec(text)?.[1];
        line.payload = Boolean(delimiter || marker);
        if (marker && (!delimiter || marker === delimiter)) { delimiter = delimiter ? '' : marker; }
        if (line.payload) { continue; }
        const languageTag = /^#\s*language\s*:\s*(ru|en)\b/iu.exec(text);
        if (languageTag) { language = languageTag[1].toLocaleLowerCase() as ScenarioLanguage; }
        const declaration = /^([^:#@|]+?)\s*:/u.exec(text)?.[1].toLocaleLowerCase();
        for (const vocabulary of keywords) {
            if (vocabulary.feature.some(word => word.toLocaleLowerCase() === declaration)) { line.kind = 'feature'; }
            else if ([...vocabulary.scenario, ...vocabulary.outline].some(word => word.toLocaleLowerCase() === declaration)) { line.kind = 'scenario'; }
            else if (vocabulary.background.some(word => word.toLocaleLowerCase() === declaration)) { line.kind = 'background'; }
            else if (vocabulary.examples.some(word => word.toLocaleLowerCase() === declaration)) { line.kind = 'other'; }
        }
        if (/^(?:Variables|Hyperlinks|Links|Переменные|Гиперссылки|Ссылки|Rule|Правило)\s*:/iu.test(text)) { line.kind = 'other'; }
        if (!line.kind && keywords.some(vocabulary => vocabulary.steps.some(word => text.replace(/^\*\s*/u, '').toLocaleLowerCase().startsWith(`${word.toLocaleLowerCase()} `)))) { line.kind = 'step'; }
        if (!line.kind && /^(?:(?:Try|Except|Else|Попытка|Исключение|Иначе)\s*$|ElseIf\s+.+\s+Then\s*$|ИначеЕсли\s+.+\s+Тогда\s*$)/iu.test(text)) { line.kind = 'step'; }
        if (!line.kind && yaml && /^Do While\s/iu.test(text)) { line.kind = 'step'; }
        if (!line.kind && /^\*\s*\S/u.test(text)) { line.kind = 'group'; }
    }
    if (!yaml && !allowed.some(line => line.kind === 'feature')) { return undefined; }
    return { lines: allowed, yaml, blockLine, minimumIndent, language, eol: source.text.includes('\r\n') ? '\r\n' : '\n' };
}

function sectionFor(view: Scan, line: Line): Line | undefined {
    return view.lines.filter(candidate => candidate.number < line.number && candidate.kind && !['step', 'group'].includes(candidate.kind)).at(-1);
}
function isBodyTarget(view: Scan, line: Line): boolean {
    const kind = sectionFor(view, line)?.kind;
    return ['step', 'group'].includes(line.kind!) && (view.yaml ? !kind || ['scenario', 'background'].includes(kind) : ['scenario', 'background'].includes(kind!));
}
function existingBefore(view: Scan, subject: Line, excludedLine: number): Set<string> {
    const existing = new Set<string>();
    for (const line of view.lines.filter(line => line.number < subject.number).reverse()) {
        if (line.number === excludedLine) { continue; }
        if (line.payload || (line.text.trim() && !isAnnotation(line.text))) { break; }
        if (/^\s*(?:@|#\[autodoc\.)/iu.test(line.text)) { annotationIds(line.text).forEach(value => existing.add(value)); }
    }
    return existing;
}

export function getGherkinStepAnnotationTarget(source: GherkinAnnotationSource, lineNumber: number): {
    readonly sectionLine: number; readonly start: number; readonly indentation: string; readonly eol: string; readonly tags: readonly string[];
} | undefined {
    const view = scan(source);
    const line = view?.lines.find(line => line.number === lineNumber);
    if (!view || !line || line.payload || !isBodyTarget(view, line)) { return undefined; }
    const existing = existingBefore(view, line, -1);
    return { sectionLine: sectionFor(view, line)?.number ?? view.blockLine, start: line.start, indentation: indent(line), eol: view.eol,
        tags: STEP_TAGS.filter(tag => !existing.has(`@${tag}`.toLocaleLowerCase())) };
}

/** One scan for runtime result matching; docstrings, tables and headers are not executable lines. */
export function collectGherkinExecutableLines(source: GherkinAnnotationSource): readonly { lineNumber: number; text: string }[] {
    const view = scan(source);
    return view ? view.lines.filter(line => !line.payload && isBodyTarget(view, line)).map(line => ({ lineNumber: line.number + 1, text: line.text.trim() })) : [];
}

/** Only standalone tag tokens are indexed; comments, step annotations and metadata values are excluded. */
export function collectGherkinProjectTags(source: GherkinAnnotationSource): readonly string[] {
    const view = scan(source);
    if (!view || view.yaml) { return []; }
    const tags = new Set<string>();
    for (const line of view.lines) {
        if (line.payload || !/^\s*@/u.test(line.text) || /^\s*@[^\s]+:\s/iu.test(line.text)) { continue; }
        const next = view.lines.find(candidate => candidate.number > line.number && candidate.text.trim() && !isAnnotation(candidate.text));
        if (!next || !['feature', 'scenario'].includes(next.kind!)) { continue; }
        for (const tag of line.text.trim().split(/[ \t]+/u)) {
            if (/^@[^\s@\u0000-\u001F\u007F]+$/u.test(tag) && !ANNOTATIONS.some(value => value.label.toLocaleLowerCase() === tag.toLocaleLowerCase())) { tags.add(tag); }
        }
    }
    return [...tags];
}

function atStepPrefix(line: Line, character: number): boolean {
    const start = contentStart(line);
    const body = line.text.slice(start);
    const marker = /^\*[ \t]+/u.exec(body)?.[0] ?? '';
    const remainder = body.slice(marker.length);
    const keyword = STEP_KEYWORDS.find(word => remainder.slice(0, word.length).toLocaleLowerCase() === word.toLocaleLowerCase()
        && (remainder.length === word.length || /^[ \t]/u.test(remainder.slice(word.length))));
    const keywordWidth = keyword ? keyword.length + (/^[ \t]*/u.exec(remainder.slice(keyword.length))?.[0].length ?? 0) : 0;
    return character <= start + marker.length + keywordWidth;
}

function completionContext(view: Scan, line: Line, character: number, invoked: boolean): CompletionContext | undefined {
    if (line.payload || character < 0 || character > line.text.length) { return undefined; }
    if (view.yaml && !line.kind) {
        const previous = view.lines.filter(candidate => candidate.number > view.blockLine && candidate.number < line.number
            && candidate.kind && ['step', 'group'].includes(candidate.kind)).at(-1);
        // Arguments belong to their calling step; a deeper blank slot is not a new step.
        // Groups and control blocks may legitimately contain steps at a deeper indent.
        if (previous?.kind === 'step' && indent(line).length > indent(previous).length
            && !/^\s*(?:Do|If|ElseIf|Else|Try|Except|Если|ИначеЕсли|Иначе|Попытка|Исключение|Цикл)(?:\s|$)/iu.test(previous.text)) {
            return undefined;
        }
    }
    let subject = line;
    let tokenStart = 0;
    let tokenEnd = line.text.length;
    let token = '';
    let tokenPrefix = '';
    const atSubject = Boolean(line.kind && ['feature', 'scenario', 'step', 'group'].includes(line.kind));
    if (atSubject) {
        // Manual completion inside step text belongs to the step/argument providers.
        // Annotations can be inserted at its prefix or on their own annotation line.
        if (!invoked || (['step', 'group'].includes(line.kind!) && (!isBodyTarget(view, line) || !atStepPrefix(line, character)))) { return undefined; }
    } else {
        const prefix = line.text.slice(0, character).replace(/^\uFEFF/u, '');
        const match = /@[^\s@]*$/u.exec(prefix);
        if (match && /^\s*(?:@[^\s@]+[ \t]+)*$/u.test(prefix.slice(0, match.index))) {
            tokenStart = match.index + (line.text.startsWith('\uFEFF') ? 1 : 0);
            tokenEnd = tokenStart + (/^@[^\s@]*/u.exec(line.text.slice(tokenStart))![0].length);
            token = line.text.slice(tokenStart, tokenEnd);
            tokenPrefix = prefix.slice(match.index);
        } else if (/^\s*#(?:\[[\w.]*\]?)?[ \t]*$/u.test(line.text) || !line.text.trim()) {
            tokenStart = contentStart(line);
            token = line.text.slice(tokenStart).trim();
            tokenPrefix = prefix.trimStart();
        } else { return undefined; }
        const next = view.lines.find(candidate => candidate.number > line.number && candidate.text.trim() && !isAnnotation(candidate.text));
        if (next) {
            if (next.payload || !next.kind || (['step', 'group'].includes(next.kind) && !isBodyTarget(view, next))) { return undefined; }
            subject = next;
        } else {
            const section = sectionFor(view, line);
            const previousStep = view.lines.filter(candidate => candidate.number < line.number && candidate.number > (section?.number ?? view.blockLine)
                && ['step', 'group'].includes(candidate.kind!)).at(-1);
            const indentation = line.text.trim() ? indent(line) : previousStep ? indent(previousStep)
                : view.yaml ? ' '.repeat(view.minimumIndent) : `${section ? indent(section) : ''}    `;
            const pendingStep = { ...line, text: indentation + line.text.trimStart(), number: line.number + 1, kind: 'step' as const };
            if (!isBodyTarget(view, pendingStep)) { return undefined; }
            subject = pendingStep;
        }
    }
    return { subject, atSubject, tokenStart, tokenEnd, token, tokenPrefix };
}

export function isGherkinHeaderAnnotationContext(source: GherkinAnnotationSource, lineNumber: number, character: number, invoked: boolean): boolean {
    const view = scan(source);
    const line = view?.lines.find(line => line.number === lineNumber);
    const context = view && line && completionContext(view, line, character, invoked);
    return Boolean(context && ['feature', 'scenario'].includes(context.subject.kind!));
}

/** Completion ranges preserve physical source offsets, including YAML indentation and original steps. */
export function buildGherkinAnnotationCompletions(source: GherkinAnnotationSource, lineNumber: number, character: number, invoked: boolean,
    projectTags: readonly string[] = [], translate = (message: string) => message): readonly GherkinAnnotationCompletion[] {
    const view = scan(source);
    const line = view?.lines.find(line => line.number === lineNumber);
    const context = view && line && completionContext(view, line, character, invoked);
    if (!context || !view || !line) { return []; }
    const { subject, atSubject, tokenStart, tokenEnd, token, tokenPrefix } = context;
    const existing = existingBefore(view, subject, atSubject ? -1 : lineNumber);
    if (!atSubject && tokenStart > contentStart(line)) {
        annotationIds(line.text.slice(0, tokenStart)).forEach(value => existing.add(value));
    }
    const candidates = ANNOTATIONS.filter(value => value.kinds.includes(subject.kind!));
    if (['feature', 'scenario'].includes(subject.kind!)) {
        const known = new Set(candidates.map(value => value.label.toLocaleLowerCase()));
        for (const tag of [...projectTags, ...collectGherkinProjectTags(source)]) {
            if (!/^@[^\s@\u0000-\u001F\u007F]+$/u.test(tag) || known.has(tag.toLocaleLowerCase())) { continue; }
            known.add(tag.toLocaleLowerCase());
            candidates.push({ label: tag, documentation: 'Tag used in this project. Its behavior depends on Vanessa run settings.', kinds: ['feature', 'scenario'] });
        }
    }
    const scenario = sectionFor(view, line);
    const feature = view.lines.filter(candidate => candidate.kind === 'feature' && candidate.number < (scenario?.number ?? lineNumber)).at(-1);
    const exported = scenario?.kind === 'scenario' && (existingBefore(view, scenario, -1).has('@exportscenarios') || (feature && existingBefore(view, feature, -1).has('@exportscenarios')));
    const preamble = scenario && view.lines.filter(candidate => candidate.number > scenario.number && candidate.number <= lineNumber);
    if (!view.yaml && !atSubject && ['step', 'group'].includes(subject.kind!) && exported && preamble && !preamble.some(candidate => candidate.kind === 'step' || candidate.kind === 'group' || candidate.kind === 'other')) {
        const metadataText = preamble.filter(candidate => candidate.number !== lineNumber).map(candidate => candidate.text.trim().toLocaleLowerCase());
        for (const metadata of METADATA) {
            if (metadataText.some(text => text.startsWith(metadata.en) || text.startsWith(metadata.ru))) { continue; }
            for (const label of view.language === 'ru' ? [metadata.ru, metadata.en] : [metadata.en, metadata.ru]) {
                candidates.push({ label, documentation: metadata.documentation, field: metadata.field, kinds: [], metadata: metadata.key });
            }
        }
    }
    const onlyDirectives = token.startsWith('#');
    const onlyTags = token.startsWith('@') && (!invoked || tokenStart > contentStart(line));
    return candidates.filter(value => !existing.has(value.label.toLocaleLowerCase()) && (!onlyDirectives || value.label.startsWith('#')) && (!onlyTags || value.label.startsWith('@')))
        .map(value => {
            const snippet = Boolean(value.field);
            const annotation = value.label + (value.field ? ` \${1:${escapeSnippet(translate(value.field))}}` : '');
            const insertionIndent = value.metadata && scenario ? indent(scenario) : indent(subject);
            let start = line.start;
            let end = line.start + character;
            let insertText: string;
            if (atSubject) {
                const bom = line.text.startsWith('\uFEFF') ? '\uFEFF' : '';
                end = line.start + Math.max(character, bom.length);
                const originalPrefix = line.text.slice(bom.length, Math.max(character, bom.length));
                insertText = `${bom}${insertionIndent}${annotation}${view.eol}${snippet ? escapeSnippet(originalPrefix) : originalPrefix}`;
            } else {
                const singleToken = tokenStart === contentStart(line);
                start = line.start + (singleToken ? contentStart(line) - indent(line).length : tokenStart);
                end = line.start + tokenEnd;
                insertText = (singleToken ? insertionIndent : '') + annotation;
            }
            const filterLabel = tokenPrefix.startsWith('@') && value.label.startsWith('#') ? `@${value.label.slice(2, -1)}` : value.label;
            return { label: value.label, documentation: translate(value.documentation), start, end, insertText, snippet,
                filterText: atSubject ? line.text.slice(0, character) || value.label : `${line.text.slice(start - line.start, tokenStart)}${filterLabel}` };
        });
}
