import { randomUUID } from 'node:crypto';
import { parseDocument, visit } from 'yaml';
import { parseExportScenarios } from './exportScenarioParser';
import { extractExportScenarioQuotedValues } from './exportScenarioCreator';
import { parseScenarioParameterDefinitions } from './scenarioParameterUtils';
import { splitLegacySpprScenario, joinNativeSpprScenario } from './spprScenarioFormat';
import { parseCompilerParameterBinding, scanCompilerLines } from './scenarioCompilerSyntax';
import { compileProjectDefinitionMatcher } from './projectDefinitionMatcher';
import type { ProjectDefinition } from './projectDefinition';
import { scanFeatureStructure } from './featureEditorActions';

export interface CallableParameter { name: string; argument: string; value: string }
class CallableConversionError extends Error {
    constructor(readonly key: string, readonly args: string[]) {
        super(key.replace(/\{(\d+)\}/gu, (_match, index) => args[Number(index)] ?? ''));
    }
}
export function callableConversionErrorText(error: unknown, translate: (key: string, ...args: string[]) => string): string {
    return error instanceof CallableConversionError ? translate(error.key, ...error.args) : translate(error && typeof error === 'object' && 'message' in error ? String(error.message) : String(error));
}
const context = { sourceUri: '', workspaceFolderUri: '', profileId: '', libraryRootUri: '', sourceLabel: '', defaultLanguage: 'en' as const };
const identifier = /^[\wА-Яа-яЁё-]+$/u;
const eolOf = (text: string): '\n' | '\r\n' => text.includes('\r\n') ? '\r\n' : '\n';
const languageOf = (text: string): 'en' | 'ru' => /#\s*language\s*:\s*ru\b/iu.test(text) ? 'ru' : 'en';

/** SPPR indents record markers by four spaces and their fields by eight, excluding the dash width. */
export function stringifyCallableMetadata(metadata: ReturnType<typeof parseDocument>): string {
    const source = metadata.toString({ indent: 4, indentSeq: false, lineWidth: 0 });
    const insertions: number[] = [];
    visit(parseDocument(source, { keepSourceTokens: true }), { Seq(_key, sequence) {
        if (sequence.srcToken?.type !== 'block-seq') { return; }
        for (const item of sequence.srcToken.items) {
            const marker = item.start.find(token => token.type === 'seq-item-ind');
            if (!marker) { continue; }
            const start = source.lastIndexOf('\n', marker.offset - 1) + 1;
            const indent = source.slice(start, marker.offset);
            if (/^ *$/u.test(indent) && indent.length % 4 === 2) { insertions.push(start); }
        }
    } });
    // CST markers keep multiline scalar contents, including lines beginning with '-', untouched.
    const result = insertions.sort((left, right) => right - left).reduce((text, start) => text.slice(0, start) + '  ' + text.slice(start), source);
    if (parseDocument(result).errors.length) { throw new Error('The converted metadata cannot be represented with SPPR indentation.'); }
    return result;
}

export function validateCallableName(value: string): string {
    const name = value.trim();
    if (!name || /[\r\n\0]/u.test(value)) { throw new Error('The name must be a non-empty single line.'); }
    return name;
}
function signature(title: string): string[] {
    validateCallableName(title);
    const values = extractExportScenarioQuotedValues(title);
    // Reparse, so malformed quotes and outline placeholders cannot bypass validation.
    const parsed = parseExportScenarios(`# language: en\n@ExportScenarios\nFeature: Exports\nScenario: ${title}\n`, context);
    const definition = parsed.definitions[0];
    if (!definition || definition.parameters.some(item => item.source !== 'quoted') || /[<>]/u.test(title)
        || values.length !== definition.parameters.length || /["']/u.test(values.reduceRight((text, item) => text.slice(0, item.start - 1) + text.slice(item.end + 1), title))) {
        throw new Error('Use complete quoted parameter names in the export title.');
    }
    const names = values.map(item => item.value);
    const seen = new Set<string>();
    for (const name of names) {
        if (!name.trim()) { throw new Error('Parameter name must not be empty.'); }
        if (seen.has(name.toLowerCase())) { throw new CallableConversionError('Duplicate parameter name: {0}.', [name]); }
        seen.add(name.toLowerCase());
    }
    return names;
}
function dedent(text: string): string {
    const lines = text.split(/\r\n|\n/u);
    const indentation = Math.min(...lines.filter(line => line.trim()).map(line => /^[ \t]*/u.exec(line)![0].length));
    return lines.map(line => line.slice(Math.min(indentation, /^[ \t]*/u.exec(line)![0].length))).join(eolOf(text));
}

export function nestedExportDraft(source: string): { title: string; parameters: CallableParameter[] } {
    const { metadata } = splitLegacySpprScenario(source);
    const yaml = parseDocument(metadata);
    if (yaml.errors.length || !yaml.getIn(['ДанныеСценария', 'UID'])) { throw new Error('Choose an unambiguous nested scenario with a UID.'); }
    const parameters = [...parseScenarioParameterDefinitions(source).values()];
    const declared = yaml.toJS().ПараметрыСценария;
    if (Array.isArray(declared) && declared.length !== parameters.length) { throw new Error('Invalid or duplicate scenario parameters.'); }
    if (parameters.some(item => item.outgoing)) { throw new Error('Export conversion cannot preserve outgoing SPPR parameters.'); }
    if (parameters.some(item => item.type === 'table')) { throw new Error('Export conversion cannot preserve table SPPR parameters.'); }
    const name = String(yaml.getIn(['ДанныеСценария', 'Имя']) ?? '');
    return { title: [name, ...parameters.map(item => `"${item.name}"`)].join(' '),
        parameters: parameters.map(item => ({ name: item.name, argument: item.name, value: item.value })) };
}

export function validateNestedExportTitle(parameters: readonly CallableParameter[], title: string): CallableParameter[] {
    const names = signature(title);
    for (const parameter of parameters) {
        if (!names.includes(parameter.name)) { throw new CallableConversionError('Keep parameter "{0}" in the export title.', [parameter.name]); }
    }
    for (const name of names) {
        if (!parameters.some(item => item.name === name)) { throw new CallableConversionError('Unknown parameter "{0}" in the export title.', [name]); }
    }
    return names.map(name => parameters.find(item => item.name === name)!);
}

export function nestedToExport(source: string, title: string): { feature: string; parameters: CallableParameter[] } {
    const parameters = validateNestedExportTitle(nestedExportDraft(source).parameters, title);
    const names = parameters.map(parameter => parameter.name);
    const { script } = splitLegacySpprScenario(source);
    const lines = dedent(script).split(/\r\n|\n/u);
    const scanned = scanCompilerLines(lines);
    const body = lines.map((line, index) => {
        if (scanned[index].kind === 'comment') { return /^\s*#\s*language\s*:/iu.test(line) ? '' : line; }
        if (scanned[index].kind === 'code' && (scanned[index].block || parseCompilerParameterBinding(line))) {
            throw new Error('Expand SPPR control blocks and nested parameter bindings before export conversion.');
        }
        if (extractExportScenarioQuotedValues(line).some(value => names.includes(value.value))) {
            throw new Error('A literal in the body matches an export parameter name. Rename that parameter before conversion.');
        }
        return line.replace(/(?<!\\)\[([\wА-Яа-яЁё-]+)\]/gu, (match, name: string, offset: number) => {
            if (!names.includes(name)) { throw new CallableConversionError('Undeclared SPPR parameter: {0}.', [name]); }
            if (scanned[index].kind === 'table' || scanned[index].kind === 'docString') {
                throw new CallableConversionError('Cannot safely export a parameter reference in a table or docstring: {0}.', [name]);
            }
            const quote = line[offset - 1];
            if ((quote === '"' || quote === "'") && line[offset + match.length] === quote) { return name; }
            if (extractExportScenarioQuotedValues(line).some(value => value.start <= offset && value.end > offset)) {
                throw new CallableConversionError('Cannot export an embedded parameter reference: {0}. Use a separate quoted argument.', [name]);
            }
            return `"${name}"`;
        });
    }).join(eolOf(source)).replace(/^(?:\r?\n)+|(?:\r?\n)+$/gu, '');
    const language = languageOf(script); const eol = eolOf(source);
    const tagRecords = parseDocument(source).toJS().ТегиСценария ?? [];
    const tags = tagRecords.flatMap((record: Record<string, { Имя?: string }>) => Object.values(record).map(value => value?.Имя).filter(Boolean)) as string[];
    if (tags.some(tag => /[\s\0]/u.test(tag))) { throw new Error('Scenario tags must be single Gherkin tags before export conversion.'); }
    const feature = [`# language: ${language}`, '@ExportScenarios', `${language === 'ru' ? 'Функциональность' : 'Feature'}: ${title.trim()}`, '',
        ...tags.map(tag => '@' + tag.replace(/^@/u, '')),
        `${language === 'ru' ? 'Сценарий' : 'Scenario'}: ${title.trim()}`,
        ...body.split(eol).map(line => line ? `    ${line}` : ''), ''].join(eol);
    return { feature, parameters };
}

export function appendConvertedExport(existing: string, addition: string): string {
    const parsed = parseExportScenarios(existing, { ...context, defaultLanguage: languageOf(existing) });
    const converted = parseExportScenarios(addition, { ...context, defaultLanguage: languageOf(addition) });
    if (!parsed.feature || parsed.warnings.length) { throw new Error('Choose a valid existing feature library.'); }
    if (parsed.language !== converted.language) { throw new Error('Use the same Gherkin language in the scenario and destination library.'); }
    const scenario = converted.scenarios[0];
    if (!scenario?.exported || converted.scenarios.length !== 1) { throw new Error('Choose an exported scenario declaration.'); }
    if (parsed.scenarios.some(item => item.title.trim().toLowerCase() === scenario.title.trim().toLowerCase())) {
        throw new Error('A step or scenario with this name already exists.');
    }
    const eol = parsed.eol;
    const body = addition.slice(scenario.metadataInsertion.offset).replace(/\r\n|\r|\n/gu, eol);
    // A scenario-level tag does not turn unrelated scenarios in the destination into exports.
    return existing + (existing.endsWith('\n') ? eol : eol + eol) + `@ExportScenarios${eol}` + body;
}

function parameterNames(arguments_: readonly string[]): CallableParameter[] {
    const used = new Set<string>();
    return arguments_.map((argument, index) => {
        let name = argument.replace(/[^\wА-Яа-яЁё-]+/gu, '_').replace(/^_+|_+$/gu, '') || `Parameter${index + 1}`;
        const base = name; let suffix = 2;
        while (used.has(name.toLowerCase())) { name = `${base}_${suffix++}`; }
        used.add(name.toLowerCase());
        return { name, argument, value: '' };
    });
}

export function exportToNested(feature: string, scenarioLine: number, name: string, originalSource?: string): {
    source: string; remaining: string; parameters: CallableParameter[]; oldTitle: string;
} {
    validateCallableName(name);
    const parsed = parseExportScenarios(feature, { ...context, defaultLanguage: languageOf(feature) });
    if (parsed.warnings.length) { throw new Error(parsed.warnings[0].message); }
    const scenario = parsed.scenarios.find(item => item.exported && item.titleRange.start.line === scenarioLine);
    if (!scenario) { throw new Error('Choose an exported scenario declaration.'); }
    const lines = feature.split(/(?<=\n)/u);
    if (/^\s*(?:Scenario Outline|Scenario Template|Структура сценария|Шаблон сценария)\s*:/iu.test(lines[scenarioLine])) {
        throw new Error('Expand the scenario outline before converting it to a nested scenario.');
    }
    const structure = scanFeatureStructure({ uri: '', version: 0, text: feature, language: parsed.language });
    if (structure.sections.some(section => section.kind === 'background')) { throw new Error('Move the feature Background into the exported scenario before conversion.'); }
    if (structure.sections.some(section => section.kind === 'variables' || section.kind === 'rule')) { throw new Error('Inline feature variables and rules before converting an exported scenario.'); }
    const section = structure.sections.find(section => section.line.number === scenarioLine)!;
    const arguments_ = signature(scenario.title);
    const parameters = parameterNames(arguments_);
    const eol = eolOf(feature);
    const offset = (line: number, character: number) => lines.slice(0, line).join('').length + character;
    const start = section.tagStart;
    const end = section.end;
    const rawBody = feature.slice(offset(scenarioLine + 1, 0), end);
    const bodyLines = dedent(rawBody).split(/\r\n|\n/u); const scanned = scanCompilerLines(bodyLines);
    const body = bodyLines.map((line, index) => {
        if (scanned[index].kind === 'comment') { return line; }
        let result = line;
        for (const value of [...extractExportScenarioQuotedValues(line)].reverse()) {
            const parameter = parameters.find(item => item.argument === value.value);
            if (parameter) { result = result.slice(0, value.start) + `[${parameter.name}]` + result.slice(value.end); }
        }
        return result;
    }).join(eol).replace(/(?:\r?\n)+$/u, '');
    const original = originalSource ? splitLegacySpprScenario(originalSource).metadata : undefined;
    const metadata = parseDocument(original ?? 'ТипФайла: "Сценарий"\nДанныеСценария:\n    UID: ""\n    Имя: ""\n    Код: ""\nПараметрыСценария:\nВложенныеСценарии:\n');
    if (metadata.errors.length) { throw new Error('The archived nested metadata is invalid.'); }
    metadata.setIn(['ДанныеСценария', 'Имя'], name.trim());
    // Export bodies contain native calls or inlined steps, so old SPPR dependencies no longer describe this text.
    if (metadata.has('ВложенныеСценарии')) { metadata.set('ВложенныеСценарии', null); }
    if (!original) {
        metadata.setIn(['ДанныеСценария', 'UID'], randomUUID());
        metadata.setIn(['ДанныеСценария', 'Код'], '');
    }
    const tags = [...new Set([...(parsed.feature?.tags ?? []), ...scenario.tags].filter(tag => tag.toLowerCase() !== '@exportscenarios'))];
    if (tags.length) { metadata.set('ТегиСценария', tags.map((tag, index) => ({ [`ТегиСценария${index + 1}`]: { Имя: tag.replace(/^@/u, '') } }))); }
    else if (metadata.has('ТегиСценария')) { metadata.set('ТегиСценария', null); }
    const previous = originalSource ? nestedExportDraft(originalSource).parameters : [];
    // Keep the original declaration order and complete records on an unchanged round trip.
    if (parameters.length !== previous.length || parameters.some(item => !previous.some(old => old.name === item.argument))) {
        metadata.set('ПараметрыСценария', parameters.length ? parameters.map((parameter, index) => ({ [`ПараметрыСценария${index + 1}`]: {
            Имя: parameter.name, Значение: previous.find(item => item.name === parameter.argument)?.value ?? '', ТипПараметра: 'Строка', ИсходящийПараметр: 'Нет'
        } })) : null);
    }
    const script = `# language: ${parsed.language}${eol}${body}${eol}`;
    return { source: joinNativeSpprScenario(stringifyCallableMetadata(metadata).replace(/\n/gu, eol), script),
        remaining: feature.slice(0, start) + feature.slice(end), parameters, oldTitle: scenario.title };
}

interface CallRewrite {
    direction: 'export' | 'nested'; oldTitle: string; title: string; parameters: readonly CallableParameter[];
}
export function rewriteCallableCall(source: string, line: number, conversion: CallRewrite): string {
    const lines = source.split(/(?<=\n)/u); const original = lines[line];
    if (original === undefined) { throw new Error('The scenario call changed.'); }
    const match = /^([ \t]*)(?:(\*\s*)?)(And|И|Допустим|Given|When|Then|But|Дано|Когда|Тогда|Но|Если|If)(\s+)(.*?)(\r?\n)?$/iu.exec(original);
    if (!match) { throw new Error('The scenario call changed.'); }
    const eol = match[6] ?? eolOf(source); const prefix = match[1] + (match[2] ?? '') + match[3] + match[4];
    if (conversion.direction === 'export') {
        if (match[5].trim().replace(/\s+/gu, ' ').toLowerCase() !== conversion.oldTitle.trim().replace(/\s+/gu, ' ').toLowerCase()) { throw new Error('The scenario call changed.'); }
        const values = new Map(conversion.parameters.map(item => [item.name, JSON.stringify(item.value)]));
        const explicit = new Set<string>();
        let end = line + 1;
        const removed = new Set<number>();
        for (; end < lines.length; end++) {
            if (!lines[end].trim() || /^\s*#/u.test(lines[end])) { continue; }
            const binding = parseCompilerParameterBinding(lines[end]);
            if (!binding) { break; }
            if (binding.kind !== 'input') { throw new Error('Cannot convert output, return or table arguments to an export call.'); }
            if (!values.has(binding.name)) { throw new CallableConversionError('Unknown parameter: {0}.', [binding.name]); }
            if (!/^(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\[[\wА-Яа-яЁё-]+\])$/u.test(binding.value)) {
                throw new Error('Use complete quoted values or bracket references in scenario arguments before conversion.');
            }
            explicit.add(binding.name);
            values.set(binding.name, binding.value); removed.add(end);
        }
        let title = conversion.title;
        for (const value of [...extractExportScenarioQuotedValues(title)].reverse()) {
            const parameter = conversion.parameters.find(item => item.name === value.value);
            if (!parameter) { throw new CallableConversionError('Unknown parameter: {0}.', [value.value]); }
            const raw = values.get(parameter.name)!;
            if (!explicit.has(parameter.name) && /[\r\n]/u.test(parameter.value)) { throw new Error('Multiline defaults cannot be passed to an export call.'); }
            const token = /^\[.*\]$|^".*"$|^'.*'$/u.test(raw) ? raw : JSON.stringify(raw);
            title = title.slice(0, value.start - 1) + token + title.slice(value.end + 1);
        }
        lines[line] = prefix + title + (match[6] ?? '');
        return lines.filter((_item, index) => !removed.has(index)).join('');
    }
    const definition: ProjectDefinition = { id: '', kind: 'exportScenario', template: conversion.oldTitle, normalizedTemplate: conversion.oldTitle,
        sourceLabel: '', parameters: conversion.parameters.map((item, index) => ({ name: item.argument, index, source: 'quoted' })) };
    const invocation = compileProjectDefinitionMatcher(definition).match(match[5]);
    if (!invocation || invocation.arguments.length !== conversion.parameters.length) { throw new Error('The exported scenario call changed.'); }
    const bindings = invocation.arguments.map((argument, index) => {
        const parameter = conversion.parameters[index];
        if (!identifier.test(parameter.name)) { throw new CallableConversionError('Invalid nested parameter name: {0}.', [parameter.name]); }
        const opening = match[5][argument.start - 1];
        const token = opening === '[' ? match[5].slice(argument.start - 1, argument.end + 1) : JSON.stringify(argument.value);
        return `${match[1]}    ${parameter.name} = ${token}`;
    });
    lines[line] = prefix + conversion.title + (bindings.length ? eol + bindings.join(eol) : '') + (match[6] ?? '');
    return lines.join('');
}
