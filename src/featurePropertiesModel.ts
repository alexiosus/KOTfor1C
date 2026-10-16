import { buildFeatureEditorActions, scanFeatureStructure, type FeatureEditorSource } from './featureEditorActions';
import { parseStandaloneFeatureSource } from './standaloneFeatureModel';
import { normalizeFeatureTags } from './featureTags';

export interface FeaturePropertiesDocument { uri: string; text: string; version: number; dirty?: boolean }
export interface FeaturePropertiesEdit { uri: string; version: number; field: 'title' | 'description' | 'tags'; value: string }
function structure(document: FeaturePropertiesDocument) {
    const language = parseStandaloneFeatureSource(document.text, '').language;
    const source: FeatureEditorSource = { ...document, language };
    const parsed = scanFeatureStructure(source);
    const feature = parsed.sections.find(section => section.kind === 'feature');
    if (!feature) { throw new Error('The feature declaration is unavailable.'); }
    const next = parsed.sections.find(section => section.line.number > feature.line.number);
    const description = parsed.lines.filter(line => line.number > feature.line.number && line.start < (next?.tagStart ?? document.text.length)
        && line.text.trim() && !/^\s*(?:#|\/\/|@)/u.test(line.text));
    return { ...parsed, source, feature, description };
}
function sectionTitle(text: string): string { return text.slice(text.indexOf(':') + 1).trim(); }
export function readFeatureProperties(document: FeaturePropertiesDocument) {
    const parsed = structure(document);
    const actions = buildFeatureEditorActions(parsed.source);
    return {
        title: sectionTitle(parsed.feature.line.text), language: parsed.source.language,
        description: parsed.description.length ? parsed.lines.filter(line => line.start >= parsed.description[0].start
            && line.start <= parsed.description.at(-1)!.start && !/^\s*(?:#|\/\/)/u.test(line.text)).map(line => line.text).join('\n') : '',
        tags: document.text.slice(parsed.feature.tagStart, parsed.feature.line.start).split(/\r?\n/u)
            .filter(line => /^\s*@/u.test(line.replace(/^\uFEFF/u, ''))).flatMap(line => line.match(/@[^\s@]+/gu) ?? []),
        line: parsed.feature.line.number,
        actions: actions.filter(action => !['scenario', 'outline'].includes(parsed.sections.find(section => section.line.number === action.line)?.kind ?? '')),
        scenarios: parsed.sections.filter(section => ['scenario', 'outline'].includes(section.kind)).map(section => ({
            title: sectionTitle(section.line.text), line: section.line.number, kind: section.kind,
            actions: actions.filter(action => action.line === section.line.number)
        }))
    };
}
export function planFeaturePropertiesEdit(document: FeaturePropertiesDocument, edit: FeaturePropertiesEdit): { start: number; end: number; text: string } {
    if (document.uri !== edit.uri || document.version !== edit.version) { throw new Error('The feature changed. Refresh the form and retry.'); }
    const parsed = structure(document); const { feature, eol } = parsed;
    if (edit.field === 'title') {
        if (!edit.value.trim() || /[\r\n\0]/u.test(edit.value)) { throw new Error('The name must be a non-empty single line.'); }
        const match = /^(.*?:[ \t]*)(.*?)([ \t]*)$/u.exec(feature.line.text)!;
        return { start: feature.line.start + match[1].length, end: feature.line.start + match[1].length + match[2].length, text: edit.value.trim() };
    }
    if (edit.field === 'tags') {
        if (/[\r\n\0]/u.test(edit.value)) { throw new Error('Invalid feature tag.'); }
        const tags = normalizeFeatureTags(edit.value.trim().split(/\s+/u).filter(Boolean)).map(tag => '@' + tag);
        const start = feature.tagStart + (feature.tagStart === 0 && document.text.startsWith('\uFEFF') ? 1 : 0);
        const end = feature.line.start + (feature.line.start === 0 && document.text.startsWith('\uFEFF') ? 1 : 0);
        const retained = document.text.slice(start, end).split(/(?<=\n)/u).filter(line => !/^\s*@/u.test(line)).join('');
        return { start, end, text: (tags.length ? tags.join(' ') + eol : '') + retained };
    }
    if (edit.field !== 'description') { throw new Error('Unknown feature field.'); }
    const text = edit.value.replace(/\r\n?/gu, '\n').trimEnd();
    if (/^\s*(?:@|#\s*language\s*:)/imu.test(text) || (['ru', 'en'] as const).some(language =>
        scanFeatureStructure({ ...parsed.source, language, text }).sections.length > 0)) {
        throw new Error('Description must not contain section headers or tags.');
    }
    const first = parsed.description[0]; const last = parsed.description.at(-1);
    if (!first || !last) { return { start: feature.line.fullEnd, end: feature.line.fullEnd,
        text: (feature.line.fullEnd === document.text.length && !document.text.endsWith('\n') ? eol : '') + (text ? text.replace(/\n/gu, eol) + eol : '') }; }
    const comments = parsed.lines.filter(line => line.start >= first.start && line.start <= last.start && /^\s*(?:#|\/\/)/u.test(line.text))
        .map(line => line.text + eol).join('');
    return { start: first.start, end: last.fullEnd, text: (text ? text.replace(/\n/gu, eol) + eol : '') + comments };
}
