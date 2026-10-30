import { parseExportScenarios, type ExportScenarioParseContext } from './exportScenarioParser';
import { compileProjectDefinitionMatcher } from './projectDefinitionMatcher';
import { normalizeProjectDefinitionTemplate, type ProjectDefinition } from './projectDefinition';
import { getGherkinDefinitionKeywords } from './gherkinDefinitionKeywords';
import { scanCompilerLines } from './scenarioCompilerSyntax';

interface RenamePlan { readonly before: string; readonly after: string }

function title(value: string): string {
    const result = value.trim();
    if (!result || /[\r\n\0]/u.test(result)) {
        throw new Error('The name must be a non-empty single line.');
    }
    return result;
}

function lines(source: string): { text: string; start: number }[] {
    const parts = source.split(/(\r\n|\r|\n)/u);
    const result: { text: string; start: number }[] = [];
    let offset = 0;
    for (let index = 0; index < parts.length; index += 2) {
        result.push({ text: parts[index], start: offset });
        offset += parts[index].length + (parts[index + 1]?.length ?? 0);
    }
    return result;
}

function parseFeature(source: string) {
    const first = /^(?:\uFEFF)?\s*(Feature|Functionality|Business Need|Ability|Функциональность|Функционал|Функция)\s*:/imu.exec(source);
    return parseExportScenarios(source, {
        sourceUri: '', workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '',
        defaultLanguage: /[A-Za-z]/u.test(first?.[1] ?? '') ? 'en' : 'ru'
    });
}

export function planFeatureTitleRename(source: string, expectedTitle: string, newTitle: string): RenamePlan {
    const name = title(newTitle);
    const parsed = parseFeature(source);
    if (!parsed.feature || parsed.feature.title !== expectedTitle) {
        throw new Error('The feature title changed. Please retry.');
    }
    const line = lines(source)[parsed.feature.declarationRange.start.line];
    const match = /^((?:\uFEFF)?[ \t]*[^:]+:[ \t]*)(.*?)([ \t]*)$/u.exec(line.text);
    if (!match) { throw new Error('The feature declaration is no longer available.'); }
    const start = line.start + match[1].length;
    return { before: source, after: source.slice(0, start) + name + source.slice(start + match[2].length) };
}

function tokenRange(text: string, start: number, end: number): { start: number; end: number } {
    const opening = text[start - 1];
    const closing = text[end];
    return (opening === '"' || opening === "'") && opening === closing || opening === '[' && closing === ']'
        ? { start: start - 1, end: end + 1 }
        : { start, end };
}

/** Replace only template literals; preserve the caller's actual argument tokens and step keyword. */
export function renameExportScenarioInvocation(
    definition: ProjectDefinition, newTemplate: string, invocation: string
): string | null {
    const previous = compileProjectDefinitionMatcher(definition).match(invocation);
    if (!previous) { return null; }
    const next = compileProjectDefinitionMatcher({
        ...definition, template: newTemplate, normalizedTemplate: normalizeProjectDefinitionTemplate(newTemplate)
    }).match(newTemplate);
    if (!next || previous.arguments.length !== next.arguments.length) {
        throw new Error('Keep the existing export scenario parameters when renaming.');
    }
    let body = newTemplate.slice(next.invocationRange.start, next.invocationRange.end);
    for (let index = next.arguments.length - 1; index >= 0; index -= 1) {
        const from = tokenRange(invocation, previous.arguments[index].start, previous.arguments[index].end);
        const to = tokenRange(newTemplate, next.arguments[index].start, next.arguments[index].end);
        body = body.slice(0, to.start - next.invocationRange.start)
            + invocation.slice(from.start, from.end)
            + body.slice(to.end - next.invocationRange.start);
    }
    return invocation.slice(0, previous.invocationRange.start) + body + invocation.slice(previous.invocationRange.end);
}

export function planExportScenarioRename(
    source: ExportScenarioParseContext & { readonly text: string }, definitionId: string, newTitle: string
): RenamePlan & { readonly definition: ProjectDefinition } {
    const name = title(newTitle);
    const parsed = parseExportScenarios(source.text, source);
    const definition = parsed.definitions.find(item => item.id === definitionId);
    if (!definition?.definitionLocation) { throw new Error('The exported scenario changed. Please retry.'); }
    const keywords = getGherkinDefinitionKeywords(parsed.language);
    const next = parseExportScenarios(`#language: ${parsed.language}\n@ExportScenarios\n${keywords.feature[0]}: Exports\n${keywords.scenario[0]}: ${name}\n`, source).definitions[0];
    if (!next || next.parameters.length !== definition.parameters.length
        || next.parameters.some((parameter, index) => parameter.name !== definition.parameters[index].name
            || parameter.source !== definition.parameters[index].source)) {
        throw new Error('Keep the existing export scenario parameters when renaming.');
    }
    if (parsed.definitions.some(item => item.id !== definitionId && item.normalizedTemplate.toLowerCase() === next.normalizedTemplate.toLowerCase())) {
        throw new Error('An exported scenario with this name already exists.');
    }
    const sourceLines = lines(source.text);
    const range = definition.definitionLocation.range;
    const start = sourceLines[range.start.line].start + range.start.character;
    const end = sourceLines[range.end.line].start + range.end.character;
    const edits = [{ start, end, text: name }];
    const scanned = scanCompilerLines(sourceLines.map(line => line.text));
    for (const [index, line] of sourceLines.entries()) {
        if (scanned[index].kind !== 'code') { continue; }
        const metadata = /^([ \t]*@(?:exampleofuse|примериспользования)[ \t]*:[ \t]*)(.*)$/iu.exec(line.text);
        if (!metadata || metadata[2].trim() !== definition.usageExample?.trim()) { continue; }
        const updated = renameExportScenarioInvocation(definition, name, metadata[2]);
        if (updated !== null) {
            edits.push({ start: line.start + metadata[1].length, end: line.start + line.text.length, text: updated });
        }
    }
    const after = edits.sort((a, b) => b.start - a.start)
        .reduce((text, edit) => text.slice(0, edit.start) + edit.text + text.slice(edit.end), source.text);
    return { before: source.text, after, definition };
}

export function normalizeFeatureRenameFilename(value: string): string {
    const name = value.trim();
    if (!name || name === '.' || name === '..' || /[\\/:*?"<>|\u0000-\u001F]/u.test(name)
        || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) {
        throw new Error('Enter a valid feature filename without folders.');
    }
    return /\.feature$/iu.test(name) ? name : `${name}.feature`;
}
