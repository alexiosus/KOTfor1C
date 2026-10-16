import { getGherkinDefinitionKeywords, type ScenarioLanguage } from './gherkinDefinitionKeywords';
import { normalizeFeatureTags } from './featureTags';
import { getGherkinStepAnnotationTarget } from './gherkinAnnotations';

export const FEATURE_EDITOR_COMMAND = 'kotTestToolkit.editFeatureStructure';
export type FeatureEditorActionKind = 'description' | 'background' | 'variables' | 'tags' | 'tree' | 'outline' | 'examples' | 'variable' | 'stepTag';
export type FeatureVariableKind = 'simple' | 'computed' | 'server' | 'multiline' | 'table' | 'import';
export type FeatureStepTag = 'screenshot' | 'recordvideo' | 'StopRecordVideo' | 'StartRecordVideo';
export interface FeatureEditorSource {
    readonly text: string;
    readonly uri: string;
    readonly version: number;
    readonly language: ScenarioLanguage;
}
export interface FeatureEditorTarget {
    readonly uri: string;
    readonly version: number;
    readonly line: number;
    readonly kind: FeatureEditorActionKind;
}
export interface FeatureEditorAction {
    readonly line: number;
    readonly kind: FeatureEditorActionKind;
    readonly title: string;
    readonly target: FeatureEditorTarget;
}
export interface FeatureEditorEdit {
    readonly start: number;
    readonly end: number;
    readonly snippet: string;
}
export interface FeatureEditorEditOptions {
    readonly tags?: string;
    readonly variableKind?: FeatureVariableKind;
    readonly stepLine?: number;
    readonly stepTag?: FeatureStepTag;
}

type SectionKind = 'feature' | 'scenario' | 'outline' | 'background' | 'examples' | 'variables' | 'rule';
interface Line { number: number; text: string; start: number; fullEnd: number; inDocString: boolean }
interface Section { kind: SectionKind; line: Line; keyword: string; indent: string; tagStart: number; end: number }
const STEP_TAGS: readonly FeatureStepTag[] = ['screenshot', 'recordvideo', 'StopRecordVideo', 'StartRecordVideo'];
const TITLES: Record<FeatureEditorActionKind, string> = {
    description: '+ Description', background: '+ Background', variables: '+ Variables', tags: '+ Tags', tree: '+ @tree',
    outline: 'Scenario Outline', examples: '+ Examples', variable: '+ Variable / import', stepTag: 'Step screenshot / video'
};

function escapeSnippet(text: string): string { return text.replace(/[\\$}]/gu, '\\$&'); }
function field(index: number, value: string): string { return `\${${index}:${escapeSnippet(value)}}`; }
function leadingTags(lines: readonly Line[], line: number): number {
    let result = lines[line].start;
    for (let index = line - 1; index >= 0; index--) {
        const text = lines[index].text.trim();
        if (!text || text.startsWith('#') || text.startsWith('//')) { continue; }
        if (!text.startsWith('@') || lines[index].inDocString) { break; }
        result = lines[index].start;
    }
    return result;
}

function scan(source: FeatureEditorSource): { lines: Line[]; sections: Section[]; eol: string; unit: string } {
    const keywords = getGherkinDefinitionKeywords(source.language);
    const kinds: [SectionKind, readonly string[]][] = [
        ['feature', keywords.feature], ['outline', keywords.outline], ['scenario', keywords.scenario],
        ['background', keywords.background], ['examples', keywords.examples],
        ['variables', ['Variables', 'Hyperlinks', 'Links', 'Переменные', 'Гиперссылки', 'Ссылки']], ['rule', ['Rule', 'Правило']]
    ];
    const lines: Line[] = [];
    let offset = 0;
    let delimiter = '';
    for (const [number, text] of source.text.split(/\r?\n/u).entries()) {
        const fullEnd = Math.min(source.text.length, offset + text.length + (source.text.slice(offset + text.length, offset + text.length + 2) === '\r\n' ? 2 : 1));
        const marker = /^\s*("""|```)/u.exec(text)?.[1];
        const inDocString = !!delimiter || !!marker;
        if (marker && (!delimiter || marker === delimiter)) { delimiter = delimiter ? '' : marker; }
        lines.push({ number, text, start: offset, fullEnd, inDocString });
        offset = fullEnd;
    }
    const sections: Section[] = [];
    for (const line of lines) {
        if (line.inDocString) { continue; }
        const match = /^(\s*)([^:#@|]+?)\s*:/u.exec(line.text.replace(/^\uFEFF/u, ''));
        if (!match) { continue; }
        const entry = kinds.find(([, values]) => values.some(value => value.toLocaleLowerCase() === match[2].toLocaleLowerCase()));
        if (!entry) { continue; }
        sections.push({ kind: entry[0], line, keyword: match[2], indent: match[1], tagStart: leadingTags(lines, line.number), end: source.text.length });
    }
    for (let index = 0; index < sections.length; index++) {
        const next = sections.slice(index + 1).find(section => section.kind !== 'examples');
        sections[index].end = next?.tagStart ?? source.text.length;
    }
    const widths = lines.filter(line => line.text.trim() && !line.inDocString)
        .map(line => /^( +)\S/u.exec(line.text)?.[1].length ?? 0).filter(width => width > 0);
    const unit = lines.some(line => !line.inDocString && /^\t/u.test(line.text)) ? '\t' : ' '.repeat(widths.length ? Math.min(...widths) : 4);
    return { lines, sections, eol: source.text.includes('\r\n') ? '\r\n' : '\n', unit };
}

function tagsFor(source: FeatureEditorSource, section: Section): Set<string> {
    return new Set(source.text.slice(section.tagStart, section.line.start).split(/\r?\n/u)
        .filter(line => /^\s*@/u.test(line)).flatMap(line => line.match(/@[^\s@]+/gu) ?? []));
}

export function buildFeatureEditorActions(source: FeatureEditorSource, translate = (message: string) => message): FeatureEditorAction[] {
    if (!/\.feature(?:[?#].*)?$/iu.test(source.uri)) { return []; }
    const { sections, lines } = scan(source);
    const feature = sections.find(section => section.kind === 'feature');
    if (!feature) { return []; }
    const actions: FeatureEditorAction[] = [];
    const add = (section: Section, kind: FeatureEditorActionKind) => actions.push({
        line: section.line.number, kind, title: translate(TITLES[kind]),
        target: { uri: source.uri, version: source.version, line: section.line.number, kind }
    });
    const firstSection = sections.find(section => section.line.number > feature.line.number);
    const hasDescription = lines.some(line => line.number > feature.line.number
        && line.start < (firstSection?.tagStart ?? source.text.length)
        && line.text.trim() && !/^\s*(?:#|\/\/|@)/u.test(line.text));
    if (!hasDescription) { add(feature, 'description'); }
    if (!sections.some(section => section.kind === 'background')) { add(feature, 'background'); }
    if (!sections.some(section => section.kind === 'variables')) { add(feature, 'variables'); }
    add(feature, 'tags');
    if (!tagsFor(source, feature).has('@tree')) { add(feature, 'tree'); }
    for (const section of sections) {
        if (section.kind === 'variables') { add(section, 'variable'); }
        if (section.kind === 'scenario' || section.kind === 'outline') {
            add(section, 'tags');
            add(section, section.kind === 'scenario' ? 'outline' : 'examples');
        }
    }
    return actions;
}

/** Step quick actions identify a real step directly, without enumerating every scenario's steps. */
export function getFeatureStepTagAction(source: FeatureEditorSource, stepLine: number): FeatureEditorAction | undefined {
    const step = getGherkinStepAnnotationTarget(source, stepLine);
    return step ? { line: stepLine, kind: 'stepTag', title: TITLES.stepTag,
        target: { uri: source.uri, version: source.version, line: step.sectionLine, kind: 'stepTag' } } : undefined;
}

export function getFeatureEditorSteps(source: FeatureEditorSource, sectionLine: number): { line: number; text: string }[] {
    const { sections, lines } = scan(source);
    const section = sections.find(candidate => candidate.line.number === sectionLine);
    if (!section || !['scenario', 'outline', 'background'].includes(section.kind)) { return []; }
    const examples = sections.find(candidate => candidate.kind === 'examples' && candidate.line.start > section.line.start && candidate.line.start < section.end);
    const end = examples?.tagStart ?? section.end;
    const words = getGherkinDefinitionKeywords(source.language).steps;
    return lines.filter(line => line.start > section.line.start && line.start < end && !line.inDocString
        && words.some(word => line.text.trim().replace(/^\*\s*/u, '').toLocaleLowerCase().startsWith(`${word.toLocaleLowerCase()} `)))
        .map(line => ({ line: line.number, text: line.text.trim() }));
}

export function isFeatureEditorTarget(value: unknown): value is FeatureEditorTarget {
    if (!value || typeof value !== 'object') { return false; }
    const target = value as Partial<FeatureEditorTarget>;
    return typeof target.uri === 'string' && (target.kind === 'stepTag' ? /\.(?:feature|ya?ml)(?:[?#].*)?$/iu : /\.feature(?:[?#].*)?$/iu).test(target.uri)
        && Number.isInteger(target.version) && Number.isInteger(target.line) && (target.line ?? -1) >= 0
        && typeof target.kind === 'string' && Object.hasOwn(TITLES, target.kind);
}

function variableSnippet(kind: FeatureVariableKind, language: ScenarioLanguage, indent: string, eol: string): string {
    const ru = language === 'ru';
    const name = field(1, ru ? 'Имя' : 'Name');
    const value = field(2, ru ? 'Значение' : 'Value');
    switch (kind) {
        case 'simple': return `${indent}${name} = "${value}"${eol}`;
        case 'computed': return `${indent}${name} = "{${field(2, '1+1')}\\}"${eol}`;
        case 'server': return `${indent}${name} = "{!${field(2, '1+1')}\\}"${eol}`;
        case 'multiline': return `${indent}${name} =${eol}${indent}"""${eol}${indent}${value}${eol}${indent}"""${eol}`;
        case 'table': return `${indent}| 'Имя' | 'Представление' | 'Тип' |${eol}${indent}| '${name}' | '${value}' | '${field(3, 'Справочник.Контрагенты')}' |${eol}`;
        case 'import': return `${indent}${ru ? 'Импорт' : 'Import'} "${field(1, 'variables.feature')}"${eol}`;
    }
}

/** Edits are anchored to the document version and never replace another declaration's body. */
export function planFeatureEditorEdit(source: FeatureEditorSource, target: FeatureEditorTarget, options: FeatureEditorEditOptions = {}): FeatureEditorEdit | undefined {
    if (source.uri !== target.uri || source.version !== target.version) { throw new Error('The feature changed. Run the action again.'); }
    if (target.kind === 'stepTag') {
        const step = getGherkinStepAnnotationTarget(source, options.stepLine ?? -1);
        if (!step || step.sectionLine !== target.line || !STEP_TAGS.includes(options.stepTag!)) { throw new Error('Choose a scenario step for this tag.'); }
        if (!step.tags.includes(options.stepTag!)) { return undefined; }
        return { start: step.start, end: step.start, snippet: `${step.indentation}@${options.stepTag}${step.eol}` };
    }
    if (!buildFeatureEditorActions(source).some(action => action.kind === target.kind && action.line === target.line)) { return undefined; }
    const { sections, lines, eol, unit } = scan(source);
    const section = sections.find(candidate => candidate.line.number === target.line);
    if (!section) { return undefined; }
    const ru = source.language === 'ru';
    const insert = (offset: number, snippet: string): FeatureEditorEdit => ({ start: offset, end: offset, snippet });
    const boundary = (kinds: readonly SectionKind[]) => sections.find(candidate => candidate.line.start > section.line.start && kinds.includes(candidate.kind))?.tagStart ?? source.text.length;
    const block = (offset: number, text: string) => insert(offset, `${offset > 0 && source.text[offset - 1] !== '\n' ? eol : ''}${text}${eol}`);
    switch (target.kind) {
        case 'description': return block(section.line.fullEnd, `${eol}${ru
            ? `Как ${field(1, 'Роль')} я хочу${eol}${field(2, 'описание функционала')}${eol}чтобы ${field(3, 'бизнес-эффект')}`
            : `As ${field(1, 'Role')}${eol}I want ${field(2, 'functional description')}${eol}To ${field(3, 'business effect')}`}${eol}`);
        case 'background': return block(boundary(['scenario', 'outline', 'rule']), `${section.indent}${ru ? 'Контекст' : 'Background'}:${eol}${section.indent}${unit}${ru ? 'Дано Я запускаю сценарий открытия TestClient или подключаю уже существующий' : 'Given I launch TestClient opening script or connect the existing one'}${eol}`);
        case 'variables': return block(boundary(['background', 'scenario', 'outline', 'rule']), `${section.indent}${ru ? 'Переменные' : 'Variables'}:${eol}${variableSnippet('simple', source.language, section.indent + unit, eol)}`);
        case 'variable': return block(section.end, variableSnippet(options.variableKind ?? 'simple', source.language, section.indent + unit, eol));
        case 'tags':
        case 'tree': {
            const raw = target.kind === 'tree' ? '@tree' : options.tags ?? '';
            if (/[\r\n]/u.test(raw)) { throw new Error('Invalid feature tag. Use a single line.'); }
            const existing = tagsFor(source, section);
            const tags = normalizeFeatureTags(raw.trim().split(/[ \t]+/u)).map(tag => `@${tag}`).filter(tag => !existing.has(tag));
            if (!tags.length) { return undefined; }
            const offset = section.line.start + (section.line.start === 0 && source.text.startsWith('\uFEFF') ? 1 : 0);
            return insert(offset, escapeSnippet(tags.map(tag => `${section.indent}${tag}`).join(eol) + eol));
        }
        case 'outline':
        case 'examples': {
            const stepEnd = sections.find(candidate => candidate.kind === 'examples' && candidate.line.start > section.line.start && candidate.line.start < section.end)?.line.start ?? section.end;
            const parameters = [...new Set(lines.filter(line => line.start > section.line.start && line.start < stepEnd && !/^\s*(?:#|\/\/)/u.test(line.text))
                .flatMap(line => [...line.text.matchAll(/<([^<>\r\n]+)>/gu)].map(match => match[1])))];
            const names = parameters.length ? parameters : [ru ? 'Параметр' : 'Parameter'];
            const indent = section.indent + unit;
            const table = `${indent}${ru ? 'Примеры' : 'Examples'}:${eol}${indent}${unit}| ${names.map(name => escapeSnippet(name.replace(/\|/gu, '\\|'))).join(' | ')} |${eol}${indent}${unit}| ${names.map((_, index) => field(index + 1, ru ? 'Значение' : 'Value')).join(' | ')} |${eol}`;
            const examples = block(section.end, `${eol}${table}`);
            if (target.kind === 'examples') { return examples; }
            const body = source.text.slice(section.line.start, section.end);
            const keywordStart = section.indent.length + (section.line.start === 0 && source.text.startsWith('\uFEFF') ? 1 : 0);
            return { start: section.line.start, end: section.end, snippet: escapeSnippet(body.slice(0, keywordStart))
                + (ru ? 'Структура сценария' : 'Scenario Outline') + escapeSnippet(body.slice(keywordStart + section.keyword.length)) + examples.snippet };
        }
    }
}
