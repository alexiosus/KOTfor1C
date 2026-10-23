import { isMap, isScalar, parseDocument, type Pair, type YAMLMap } from 'yaml';
import { appendCompilerYamlBlock, validateCompilerYamlBlockName, type CompilerYamlBlockSection } from './compilerYamlBlocks';
import { moveCompilerProcessStep, removeCompilerProcessStep } from './compilerProcesses';
import { compilerParameterReferenceOccurrences, getCompilerScenarioBody, scanCompilerLines } from './scenarioCompilerSyntax';
import { findScenarioReference } from './scenarioReferenceMatcher';
import { getSectionInsertionForSection, ScenarioYamlDocument, type ScenarioYamlField, type ScenarioYamlRecord, type ScenarioYamlSection, type SourceEdit } from './scenarioYamlDocument';

export interface ScenarioPropertyField { key: string; value: string; label?: string; readonly?: boolean; multiline?: boolean; choices?: string[]; suggestions?: string[]; action?: string; createAction?: string; inlineAction?: string; choiceLabels?: Record<string, string> }
export interface ScenarioPropertySection { key: string; fields?: ScenarioPropertyField[]; records?: ScenarioPropertyRecord[] }
export interface ScenarioPropertyRecord { key: string; fields: ScenarioPropertyField[]; sections?: ScenarioPropertySection[]; usages?: number }
export interface ScenarioProperties { kind: 'scenario' | 'process' | 'test' | 'processTest'; title: string; header: ScenarioPropertyField[]; sections: ScenarioPropertySection[] }
export type ScenarioPropertiesModel = ScenarioProperties;
export interface ScenarioPropertyTarget { section: string; stepUid?: string }
export interface ScenarioPropertyEdit extends ScenarioPropertyTarget { recordKey?: string; field: string; value: string }
export interface ScenarioPropertyRecordTarget extends ScenarioPropertyTarget { recordKey: string }
export interface ScenarioPropertyMove extends ScenarioPropertyRecordTarget { beforeRecordKey: string | null }

const TYPES = ['Строка', 'Число', 'Дата', 'Таблица'];
const FLAGS = ['Да', 'Нет'];
const OPTIONAL_FLAGS = ['', 'Да', 'Нет'];
const OPTIONAL_FLAG_KEYS = new Set(['НеобратимоМеняетДанные', 'Выключена']);
const PARAMETER_FIELDS = ['НомерСтроки', 'Имя', 'Значение', 'ТипПараметра', 'ИсходящийПараметр', 'НесколькоЗначений'];
const STEP_PARAMETER_FIELDS = ['Имя', 'ТипПараметра', 'ШагПроцессаЗначениеПоСсылке', 'ШагПроцессаЗначениеПоСсылкеUID', 'ИсходящийПараметр', 'ЗначениеПоСсылке', 'ЗначениеПроизвольное', 'ИмяПараметраПоСсылке'];
const HEADER_FIELDS = {
    scenario: ['UID', 'Имя', 'Код', 'Проект', 'ФункцияСистемы', 'РазрешеноИспользоватьВДругихФункциях', 'UIDФункцияСистемы', 'ПрофильПользователя', 'УровеньОтчета1', 'УровеньОтчета2', 'ВерсияСценария', 'НеобратимоМеняетДанные', 'Ответственный'],
    process: ['UID', 'Имя', 'Код', 'ПолныйКод', 'ВерсияСценария', 'Проект', 'ПрофильПользователя', 'Ответственный', 'УровеньОтчета1', 'УровеньОтчета2'],
    test: ['UID', 'Код', 'UIDСценария', 'Имя', 'ЭталоннаяБазаИмя', 'ПрофильПользователя', 'СценарийНаименование', 'ИдентификаторБазы', 'ПараметрыЗапуска', 'Выключена'],
    processTest: ['UID', 'Код', 'UIDПроцесса', 'Имя', 'ПроцессНаименование', 'ЭталоннаяБазаИмя', 'ИдентификаторБазы', 'ПрофильПользователя', 'ПараметрыЗапуска']
};
const HEADER_IDENTITIES = new Set(['UID', 'Имя', 'Код', 'ПолныйКод', 'ФункцияСистемы', 'UIDФункцияСистемы', 'UIDСценария', 'UIDПроцесса', 'СценарийНаименование', 'ПроцессНаименование']);
const STEP_IDENTITIES = new Set(['UID', 'ШагПроцесса', 'Процесс', 'Сценарий', 'СценарийUID', 'СценарийНаименование', 'СценарийКод', 'ПолныйКод', 'ВложенныйПроцессUID', 'ВложенныйПроцессНаименование', 'ТипШага']);
const KIND_HEADERS = { scenario: 'ДанныеСценария', process: 'ДанныеПроцесса', test: 'ДанныеТеста', processTest: 'ДанныеТеста' };

function newline(source: string): string { return source.includes('\r\n') ? '\r\n' : '\n'; }
function applyEdits(source: string, edits: SourceEdit[]): string {
    const updated = edits.sort((a, b) => b.range.start - a.range.start).reduce((text, edit) => text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end), source);
    ScenarioYamlDocument.parse(updated).requireValidForEdit();
    return updated;
}
function kindOf(document: ScenarioYamlDocument): ScenarioProperties['kind'] {
    const field = document.findFieldAtPath(['ТипФайла']);
    if (field?.ambiguous) { throw new Error('Unsafe YAML edit: ambiguous file type'); }
    const kinds: Record<string, ScenarioProperties['kind']> = { сценарий: 'scenario', процесс: 'process', настройкатеста: 'test', настройкапроцесса: 'processTest' };
    const kind = kinds[String(field?.value ?? '').trim().toLowerCase()];
    if (!kind) { throw new Error('Unsupported scenario YAML file type'); }
    return kind;
}
function sectionNames(kind: ScenarioProperties['kind']): string[] {
    return kind === 'scenario' ? ['ПараметрыСценария', 'ТегиСценария', 'ВложенныеСценарии']
        : kind === 'process' ? ['ПараметрыСценария', 'ТегиПроцесса', 'ШагиПроцесса'] : ['ПараметрыТеста', 'ТегиТеста'];
}
function requireMapping(document: ScenarioYamlDocument, path: readonly string[]): string[] {
    const field = document.findFieldAtPath(path);
    if (!field || field.ambiguous || field.valueKind !== 'mapping') { throw new Error(`Unsafe YAML edit: ${path.join('.')} must be one unambiguous mapping`); }
    const keys = Object.keys(field.value as object);
    for (const key of keys) {
        if (document.findFieldAtPath([...path, key])?.ambiguous) { throw new Error(`Unsafe YAML edit: duplicate field ${key}`); }
    }
    return keys;
}
function identity(record: ScenarioYamlRecord, section: string): string {
    const field = section === 'ШагиПроцесса' ? 'UID' : section === 'ВложенныеСценарии' ? 'UIDВложенныйСценарий' : 'Имя';
    return String(record.fields.get(field) ?? '').trim() || record.key;
}
function recordsForEdit(document: ScenarioYamlDocument, section: string): readonly ScenarioYamlRecord[] {
    document.findRecordFieldsForEdit(section, '');
    const records = document.readRecords(section);
    const keys = new Set<string>();
    for (const record of records) {
        const key = identity(record, section).toLowerCase();
        if (keys.has(key)) { throw new Error(`Unsafe YAML edit: ambiguous duplicate record identity in ${section}`); }
        keys.add(key);
        for (const name of record.fields.keys()) { document.findRecordFieldsForEdit(section, name); }
    }
    return records;
}
function propertyField(key: string, value: unknown, section: string, table = false): ScenarioPropertyField {
    const scalar = value === null || value === undefined || ['string', 'number', 'boolean'].includes(typeof value);
    const text = value === null || value === undefined ? '' : scalar ? String(value) : JSON.stringify(value);
    const readonly = !scalar || key === 'НомерСтроки' || (section.startsWith('Данные') ? HEADER_IDENTITIES.has(key) && !(section === 'ДанныеТеста' && ['Имя', 'Код'].includes(key))
        : section === 'ШагиПроцесса' ? STEP_IDENTITIES.has(key)
            : section === 'ВложенныеСценарии' && ['UIDВложенныйСценарий', 'ИмяСценария'].includes(key));
    const choices = key === 'ТипПараметра' ? TYPES : OPTIONAL_FLAG_KEYS.has(key) ? OPTIONAL_FLAGS
        : ['ИсходящийПараметр', 'НесколькоЗначений', 'РазрешеноИспользоватьВДругихФункциях'].includes(key) ? FLAGS : undefined;
    const presented = scalar && choices === FLAGS ? /^(?:Да|Yes|True)$/iu.test(text) ? 'Да' : 'Нет'
        : scalar && choices === OPTIONAL_FLAGS ? /^Да$/iu.test(text) ? 'Да' : /^Нет$/iu.test(text) ? 'Нет' : text : text;
    return { key, value: presented, ...(readonly ? { readonly: true } : {}), ...((table && ['Значение', 'ЗначениеПроизвольное'].includes(key)) || /[\r\n]/u.test(text) ? { multiline: true } : {}), ...(choices ? { choices: [...choices] } : {}) };
}
function knownRecordFields(section: string): string[] {
    return section === 'ПараметрыШага' ? STEP_PARAMETER_FIELDS : section.startsWith('Параметры') ? PARAMETER_FIELDS
        : section.startsWith('Теги') ? ['НомерСтроки', 'Имя'] : section === 'ВложенныеСценарии' ? ['UIDВложенныйСценарий', 'ИмяСценария'] : ['UID', 'Наименование', 'ИсполнительНаименование', 'ПараметрыШага', 'ТипШага'];
}
function displayValue(source: string, field: ScenarioYamlField | null, fallback: unknown): unknown {
    if (!field || !['mapping', 'sequence'].includes(field.valueKind)) { return fallback; }
    const fragment = parseDocument(source.slice(field.pairRange.start, field.pairRange.end), { prettyErrors: false, uniqueKeys: true });
    if (fragment.errors.length || !isMap(fragment.contents)) { throw new Error(`Unsafe YAML structure in ${field.key}`); }
    return (fragment.toJS() as Record<string, unknown>)[field.key];
}
function recordModel(record: ScenarioYamlRecord, section: string, source?: string, document?: ScenarioYamlDocument): ScenarioPropertyRecord {
    const keys = [...new Set([...knownRecordFields(section), ...record.fields.keys()])].filter(key => key !== 'ПараметрыШага');
    return { key: identity(record, section), fields: keys.map(key => {
        const field = document?.findRecordFieldsForEdit(section, key).find(field => field.pairRange.start >= record.range.start && field.pairRange.start <= record.range.end) ?? null;
        const value = source === undefined ? record.fields.get(key) : displayValue(source, field, record.fields.get(key));
        return propertyField(key, value, section, record.fields.get('ТипПараметра') === 'Таблица');
    }) };
}

export function readScenarioProperties(source: string, scriptText?: string): ScenarioProperties {
    const document = ScenarioYamlDocument.parse(source); document.requireValidForEdit();
    const kind = kindOf(document); const headerName = KIND_HEADERS[kind];
    const keys = [...new Set([...HEADER_FIELDS[kind], ...requireMapping(document, [headerName])])];
    const header = keys.map(key => {
        const field = document.findField(headerName, key);
        return propertyField(key, displayValue(source, field, field?.value), headerName);
    });
    const body = scriptText !== undefined ? scriptText.split(/\r\n|\r|\n/u) : getCompilerScenarioBody(source)?.lines ?? [];
    const references = compilerParameterReferenceOccurrences(body);
    const scanned = scanCompilerLines(body);
    const sections = sectionNames(kind).map(key => {
        const records = recordsForEdit(document, key);
        return { key, records: records.map((record, index) => {
            const model = recordModel(record, key, source, document);
            if (kind === 'scenario' && key === 'ПараметрыСценария') {
                model.usages = references.filter(reference => reference.name === record.fields.get('Имя')).length;
            }
            if (key === 'ВложенныеСценарии') {
                const name = String(record.fields.get('ИмяСценария') ?? '');
                model.usages = body.filter((line, index) => scanned[index].kind === 'code'
                    && findScenarioReference(line.replace(/\s+#.*$/u, ''), name)).length;
            }
            if (key === 'ШагиПроцесса') {
                const nested = document.findRecordSection(key, index, 'ПараметрыШага');
                const text = nested ? source.slice(nested.pairRange.start, nested.pairRange.end) : 'ПараметрыШага:\n';
                const scoped = ScenarioYamlDocument.parse(text);
                scoped.requireValidForEdit();
                model.sections = [{ key: 'ПараметрыШага', records: recordsForEdit(scoped, 'ПараметрыШага').map(parameter => recordModel(parameter, 'ПараметрыШага', text, scoped)) }];
                const previous = records.slice(0, index);
                for (const parameter of model.sections[0].records!) {
                    const reference = parameter.fields.find(field => field.key === 'ШагПроцессаЗначениеПоСсылкеUID')!;
                    reference.label = 'sourceStep'; reference.choices = ['', ...previous.map(step => identity(step, key))];
                    reference.choiceLabels = Object.fromEntries(previous.map(step => [identity(step, key), `${step.fields.get('ПолныйКод') || ''} ${step.fields.get('Наименование') || ''}`.trim()]));
                    reference.choiceLabels[''] = 'No source step';
                }
            }
            return model;
        }) };
    });
    return { kind, title: header.find(field => field.key === 'Имя')?.value || header.find(field => field.key === 'Код')?.value || '', header, sections };
}

interface Scope { text: string; offset: number; document: ScenarioYamlDocument; section: ScenarioYamlSection | null; records: readonly ScenarioYamlRecord[] }
function scopeFor(source: string, target: ScenarioPropertyTarget): Scope {
    const document = ScenarioYamlDocument.parse(source); document.requireValidForEdit();
    const kind = kindOf(document);
    let offset = 0; let text = source;
    if (target.section === 'ПараметрыШага') {
        if (kind !== 'process' || !target.stepUid?.trim()) { throw new Error('Missing process step UID'); }
        const steps = recordsForEdit(document, 'ШагиПроцесса');
        const index = steps.findIndex(record => identity(record, 'ШагиПроцесса') === target.stepUid);
        if (index < 0) { throw new Error('Missing or stale process step identity'); }
        const nested = document.findRecordSection('ШагиПроцесса', index, 'ПараметрыШага');
        if (!nested) { throw new Error('Missing process step parameter section'); }
        offset = nested.pairRange.start; text = source.slice(offset, nested.pairRange.end);
    } else if (target.stepUid !== undefined || !sectionNames(kind).includes(target.section)) { throw new Error('Unsupported property section'); }
    const scoped = ScenarioYamlDocument.parse(text); scoped.requireValidForEdit();
    return { text, offset, document: scoped, section: scoped.findSection(target.section), records: recordsForEdit(scoped, target.section) };
}
function requireRecord(scope: Scope, section: string, key: string): ScenarioYamlRecord {
    const matches = scope.records.filter(record => identity(record, section) === key);
    if (matches.length !== 1) { throw new Error('Missing, ambiguous or stale property record identity'); }
    return matches[0];
}
function fieldInRecord(scope: Scope, section: string, record: ScenarioYamlRecord, key: string): ScenarioYamlField | null {
    return scope.document.findRecordFieldsForEdit(section, key).find(field => field.pairRange.start >= record.range.start && field.pairRange.start <= record.range.end) ?? null;
}
function lineEnd(source: string, offset: number): number { const end = source.indexOf('\n', offset); return end < 0 ? source.length : end + 1; }
function lineIndent(source: string, offset: number): string { const start = source.lastIndexOf('\n', offset - 1) + 1; return /^[ \t]*/u.exec(source.slice(start, offset))![0]; }
function fieldEdit(source: string, field: ScenarioYamlField, value: string | number | null, literal = false, allowMultilineLiteral = true): SourceEdit {
    if (field.ambiguous || !['scalar', 'blockScalar', 'null', 'missing'].includes(field.valueKind)) { throw new Error(`Unsafe YAML edit: ${field.key} must be one unambiguous scalar`); }
    const eol = newline(source); const raw = field.valueRange ? source.slice(field.valueRange.start, field.valueRange.end) : '';
    const suffix = source.slice(field.valueRange?.end ?? field.lineEnd, field.lineEnd);
    let start = field.valueRange?.start ?? field.lineEnd;
    if (!field.valueRange) {
        const colon = source.indexOf(':', field.pairRange.start); start = colon + 1;
        while (source[start] === ' ' || source[start] === '\t') { start++; }
        if (source[start] === '#' || start >= field.lineEnd) { start = colon + 1; }
    }
    if (typeof value === 'string' && (literal || (allowMultilineLiteral && /[\r\n]/u.test(value)))) {
        const rows = value.replace(/\r\n|\r/gu, '\n').replace(/\n$/u, '').split('\n');
        const indent = lineIndent(source, field.pairRange.start) + '    ';
        const end = field.blockScalarContentRange?.end ?? field.lineEnd;
        const endsWithNewline = source.slice(start, end).endsWith('\n');
        const comment = /\s+#.*$/u.exec(suffix)?.[0] ?? '';
        return { range: { start, end }, text: `${field.valueRange ? '' : ' '}|${comment}${eol}${rows.map(row => indent + row).join(eol)}${endsWithNewline ? eol : ''}` };
    }
    const rendered = typeof value === 'string' ? raw.startsWith("'") ? `'${value.replace(/'/gu, "''")}'` : JSON.stringify(value) : String(value);
    if (field.blockScalarContentRange) {
        const end = field.blockScalarContentRange.end;
        return { range: { start, end }, text: rendered + suffix + (source.slice(start, end).endsWith('\n') ? eol : '') };
    }
    return { range: { start, end: field.valueRange?.end ?? start }, text: (field.valueRange ? '' : ' ') + rendered };
}
function insertMapField(source: string, end: number, indent: string, key: string, value: string | number | null, literal = false): SourceEdit {
    const eol = newline(source);
    const rendered = typeof value === 'string' && literal
        ? `|${eol}${value.replace(/\r\n|\r/gu, '\n').replace(/\n$/u, '').split('\n').map(row => indent + '    ' + row).join(eol)}`
        : typeof value === 'string' ? JSON.stringify(value) : String(value);
    const trailing = !['\r', '\n'].includes(source[end]) && (end < source.length || source.endsWith('\n'));
    return { range: { start: end, end }, text: `${end > 0 && source[end - 1] !== '\n' ? eol : ''}${indent}${key}: ${rendered}${trailing ? eol : ''}` };
}
function validateValue(section: string, key: string, value: string, existingValue?: unknown): void {
    const descriptor = propertyField(key, '', section);
    if (descriptor.readonly) { throw new Error(`Readonly identity field: ${key}; use the existing identity action`); }
    if (descriptor.choices && !descriptor.choices.includes(value)
        && !(key === 'ТипПараметра' && value === existingValue)) { throw new Error(`Invalid field choice: ${key}`); }
    if (key === 'Имя' && (section.startsWith('Параметры') || section.startsWith('Теги')) && !validateCompilerYamlBlockName(section as CompilerYamlBlockSection, value)) { throw new Error('Invalid parameter or tag name'); }
    if (!['Значение', 'ЗначениеПроизвольное'].includes(key) && /[\r\n]/u.test(value)) { throw new Error('Compiler property must fit on one line'); }
}

export function applyScenarioPropertyEdit(source: string, target: ScenarioPropertyEdit): string {
    const model = readScenarioProperties(source); const header = KIND_HEADERS[model.kind];
    const section = target.section === 'header' ? header : target.section;
    if (section === header) {
        if (target.recordKey !== undefined || target.stepUid !== undefined) { throw new Error('Invalid header property target'); }
        const document = ScenarioYamlDocument.parse(source); requireMapping(document, [header]);
        const field = document.findField(header, target.field);
        if (!model.header.some(field => field.key === target.field)) { throw new Error('Unsupported header field'); }
        validateValue(section, target.field, target.value, field?.value);
        if (!field && target.value === '' && (OPTIONAL_FLAG_KEYS.has(target.field) || target.field === 'Ответственный')) { return source; }
        const mapping = document.findSection(header)!;
        return applyEdits(source, [field ? fieldEdit(source, field, target.value) : insertMapField(source, mapping.bodyRange.end, mapping.itemIndent, target.field, target.value)]);
    }
    const scope = scopeFor(source, { ...target, section });
    const record = requireRecord(scope, section, target.recordKey ?? '');
    if (!recordModel(record, section).fields.some(field => field.key === target.field)) { throw new Error('Unsupported record field'); }
    validateValue(section, target.field, target.value, record.fields.get(target.field));
    if (target.field === 'ТипПараметра' && !TYPES.includes(target.value) && target.value === record.fields.get(target.field)) { return source; }
    if (target.field === 'Имя' && scope.records.some(other => other !== record && identity(other, section).toLowerCase() === target.value.toLowerCase())) { throw new Error('Duplicate parameter or tag name'); }
    const field = fieldInRecord(scope, section, record, target.field);
    const indent = lineIndent(scope.text, record.keyRange.start) + '    ';
    const literal = (record.fields.get('ТипПараметра') === 'Таблица' && ['Значение', 'ЗначениеПроизвольное'].includes(target.field)) || /[\r\n]/u.test(target.value);
    const edit = field ? fieldEdit(scope.text, field, target.value, literal)
        : insertMapField(scope.text, record.range.end, indent, target.field, target.value, literal);
    let updated = applyEdits(source, [{ range: { start: edit.range.start + scope.offset, end: edit.range.end + scope.offset }, text: edit.text }]);
    if (model.kind === 'scenario' && section === 'ПараметрыСценария' && target.field === 'Имя') {
        const bodyField = ScenarioYamlDocument.parse(updated).findFieldAtPath(['ТекстСценария']);
        if (bodyField?.blockScalarContentRange) {
            const range = bodyField.blockScalarContentRange;
            const lines = updated.slice(range.start, range.end).match(/[^\r\n]*(?:\r\n|\r|\n|$)/gu)?.filter(Boolean) ?? [];
            const occurrences = compilerParameterReferenceOccurrences(lines);
            const offsets = lines.reduce<number[]>((result, line) => [...result, result.at(-1)! + line.length], [range.start]);
            updated = applyEdits(updated, occurrences.filter(reference => reference.name === record.fields.get('Имя'))
                .map(reference => ({ range: { start: offsets[reference.line] + reference.start, end: offsets[reference.line] + reference.start + reference.length }, text: `[${target.value}]` })));
        }
    }
    if (target.field === 'ТипПараметра' && target.value === 'Таблица') {
        const valueField = section === 'ПараметрыШага' ? 'ЗначениеПроизвольное' : 'Значение';
        return applyScenarioPropertyEdit(updated, { ...target, field: valueField, value: String(record.fields.get(valueField) ?? '') });
    }
    if (section === 'ПараметрыШага' && target.field === 'ШагПроцессаЗначениеПоСсылкеUID') {
        const steps = model.sections.find(section => section.key === 'ШагиПроцесса')!.records!;
        const current = steps.findIndex(step => step.key === target.stepUid);
        const linked = steps.slice(0, current).find(step => step.key === target.value);
        if (target.value && !linked) { throw new Error('Choose a preceding source step.'); }
        return applyScenarioPropertyEdit(updated, { ...target, field: 'ШагПроцессаЗначениеПоСсылке', value: linked?.fields.find(field => field.key === 'Наименование')?.value || '' });
    }
    return updated;
}

/** The dropdown changes this stock name/UID pair together; generic header edits cannot change identities. */
export function applyScenarioSystemFunction(source: string, name: string, uid: string): string {
    const document = ScenarioYamlDocument.parse(source); document.requireValidForEdit();
    if (kindOf(document) !== 'scenario' || !name.trim() || !uid.trim() || /[\r\n]/u.test(name + uid)) { throw new Error('Invalid scenario system function.'); }
    const header = document.findSection('ДанныеСценария')!;
    const edits = [['ФункцияСистемы', name], ['UIDФункцияСистемы', uid]].map(([key, value]) => {
        const field = document.findField('ДанныеСценария', key);
        return field ? fieldEdit(source, field, value) : insertMapField(source, header.bodyRange.end, header.itemIndent, key, value);
    });
    return applyEdits(source, edits);
}

function ensureSection(source: string, target: ScenarioPropertyTarget): string {
    if (target.section === 'ПараметрыШага') {
        const document = ScenarioYamlDocument.parse(source);
        const steps = recordsForEdit(document, 'ШагиПроцесса');
        const index = steps.findIndex(record => identity(record, 'ШагиПроцесса') === target.stepUid);
        if (index < 0) { throw new Error('Missing or stale process step identity'); }
        if (!document.findRecordSection('ШагиПроцесса', index, 'ПараметрыШага')) {
            const record = steps[index];
            const indent = lineIndent(source, record.keyRange.start) + '    ';
            const edit = insertMapField(source, record.range.end, indent, 'ПараметрыШага', null);
            edit.text = edit.text.replace('ПараметрыШага: null', 'ПараметрыШага:');
            return applyEdits(source, [edit]);
        }
    }
    const scope = scopeFor(source, target);
    if (scope.section) { return source; }
    const eol = newline(source); const body = scope.document.findFieldAtPath(['ТекстСценария']);
    const offset = body?.lineStart ?? source.length;
    return applyEdits(source, [{ range: { start: offset, end: offset }, text: `${offset && source[offset - 1] !== '\n' ? eol : ''}${target.section}:${eol}` }]);
}

export function addScenarioPropertyRecord(source: string, target: ScenarioPropertyTarget, fields: Record<string, string> = {}): string {
    readScenarioProperties(source);
    if (target.section === 'ШагиПроцесса') { throw new Error('Use the existing process step picker action'); }
    let updated = ensureSection(source, target); const scope = scopeFor(updated, target);
    if (target.section === 'ВложенныеСценарии') {
        if (!fields.UIDВложенныйСценарий?.trim() || !fields.ИмяСценария?.trim()) { throw new Error('Missing linked nested scenario identity; select an existing scenario'); }
        if (Object.entries(fields).some(([key, value]) => /[\r\n]/u.test(key + value) || !/^[\p{L}\p{N}_]+$/u.test(key))) { throw new Error('Invalid nested identity: fields must fit on one line'); }
        if (scope.records.some(record => identity(record, target.section).toLowerCase() === fields.UIDВложенныйСценарий.toLowerCase())) { throw new Error('Duplicate nested scenario identity'); }
        const text = '- ВложенныеСценарии:\n' + Object.entries(fields).map(([key, value]) => `    ${key}: ${JSON.stringify(value)}`).join('\n');
        const edit = getSectionInsertionForSection(updated, scope.section!, text);
        updated = applyEdits(updated, [edit]);
    } else {
        let name = fields.Имя || (target.section.startsWith('Теги') ? 'tag' : 'Parameter'); let number = 1;
        if (!fields.Имя) { while (scope.records.some(record => identity(record, target.section).toLowerCase() === name.toLowerCase())) { name = `${target.section.startsWith('Теги') ? 'tag' : 'Parameter'}${++number}`; } }
        updated = appendCompilerYamlBlock(updated, target as { section: CompilerYamlBlockSection; stepUid?: string }, name);
        for (const [field, value] of Object.entries(fields)) {
            if (field === 'Имя') { continue; }
            updated = applyScenarioPropertyEdit(updated, { ...target, recordKey: name, field, value });
        }
    }
    return updated;
}

function chunksFor(scope: Scope): { start: number; end: number; chunks: string[] } {
    if (!scope.section || !scope.records.length) { throw new Error('Missing property records'); }
    const starts = scope.records.map(record => scope.text.lastIndexOf('\n', record.range.start - 1) + 1);
    const end = scope.section.bodyRange.end;
    return { start: starts[0], end, chunks: starts.map((start, index) => scope.text.slice(start, starts[index + 1] ?? end)) };
}
function renumber(source: string, target: ScenarioPropertyTarget): string {
    if (target.section === 'ВложенныеСценарии') { return source; }
    const scope = scopeFor(source, target); const edits: SourceEdit[] = [];
    for (const [index, record] of scope.records.entries()) {
        edits.push({ range: { start: record.keyRange.start + scope.offset, end: record.keyRange.end + scope.offset }, text: `${target.section}${index + 1}` });
        const row = fieldInRecord(scope, target.section, record, 'НомерСтроки');
        if (row) {
            const edit = fieldEdit(scope.text, row, String(index + 1));
            edits.push({ ...edit, range: { start: edit.range.start + scope.offset, end: edit.range.end + scope.offset } });
        }
    }
    return applyEdits(source, edits);
}

export function removeScenarioPropertyRecord(source: string, target: ScenarioPropertyRecordTarget): string {
    readScenarioProperties(source); const scope = scopeFor(source, target); const record = requireRecord(scope, target.section, target.recordKey);
    const index = scope.records.indexOf(record);
    if (target.section === 'ШагиПроцесса') { return removeCompilerProcessStep(source, index); }
    const chunks = chunksFor(scope); chunks.chunks.splice(index, 1);
    return renumber(applyEdits(source, [{ range: { start: chunks.start + scope.offset, end: chunks.end + scope.offset }, text: chunks.chunks.join('') }]), target);
}

export function moveScenarioPropertyRecord(source: string, target: ScenarioPropertyMove): string {
    readScenarioProperties(source); const scope = scopeFor(source, target); const record = requireRecord(scope, target.section, target.recordKey);
    const before = target.beforeRecordKey === null ? null : requireRecord(scope, target.section, target.beforeRecordKey);
    if (record === before) { return source; }
    const from = scope.records.indexOf(record); const to = before === null ? scope.records.length - 1 : scope.records.indexOf(before) - (from < scope.records.indexOf(before) ? 1 : 0);
    if (target.section === 'ШагиПроцесса') { return moveCompilerProcessStep(source, from, to); }
    const chunks = chunksFor(scope); const [moved] = chunks.chunks.splice(from, 1); chunks.chunks.splice(to, 0, moved);
    const text = chunks.chunks.map((chunk, index) => index < chunks.chunks.length - 1 && !chunk.endsWith('\n') ? chunk + newline(source) : chunk).join('');
    return renumber(applyEdits(source, [{ range: { start: chunks.start + scope.offset, end: chunks.end + scope.offset }, text }]), target);
}

/** Standard sidecar YAML is parsed strictly; null removes the targeted pair. */
export function applyYamlMapField(source: string, path: readonly string[], value: string | number | null): string {
    if (!path.length || path.some(key => !key || /[\r\n]/u.test(key)) || (typeof value === 'number' && !Number.isFinite(value))) { throw new Error('Invalid metadata field path or value'); }
    const document = parseDocument(source, { keepSourceTokens: true, prettyErrors: false, uniqueKeys: true });
    if (document.errors.length) { throw new Error(`Unsafe YAML edit: ${document.errors.map(error => error.message).join('; ')}`); }
    const eol = newline(source); let map: YAMLMap | null = isMap(document.contents) ? document.contents : null;
    if (!map && document.contents !== null) { throw new Error('Metadata root must be a mapping'); }
    let indent = ''; let insertion = source.length; let parent: Pair | undefined;
    const apply = (edits: SourceEdit[]): string => {
        const updated = edits.sort((a, b) => b.range.start - a.range.start).reduce((text, edit) => text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end), source);
        const checked = parseDocument(updated, { prettyErrors: false, uniqueKeys: true });
        if (checked.errors.length) { throw new Error(`Unsafe metadata edit: ${checked.errors.map(error => error.message).join('; ')}`); }
        return updated;
    };
    const render = (depth: number): string => path.slice(depth).map((key, index, remaining) => `${indent}${'  '.repeat(index)}${JSON.stringify(key)}:${index === remaining.length - 1 ? ' ' + (typeof value === 'string' ? JSON.stringify(value) : String(value)) : ''}`).join(eol);
    for (let index = 0; index < path.length; index++) {
        const pair: Pair | undefined = map?.items.find(item => isScalar(item.key) && item.key.value === path[index]);
        if (!pair) {
            if (value === null) { return source; }
            if (map?.flow && map.range) {
                let nested = typeof value === 'string' ? JSON.stringify(value) : String(value);
                for (let depth = path.length - 1; depth >= index; depth--) { nested = `${JSON.stringify(path[depth])}: ${nested}`; if (depth > index) { nested = `{${nested}}`; } }
                const end = map.range[1] - 1;
                return apply([{ range: { start: end, end }, text: `${map.items.length ? ', ' : ''}${nested}` }]);
            }
            const edit: SourceEdit = { range: { start: insertion, end: insertion }, text: `${insertion && source[insertion - 1] !== '\n' ? eol : ''}${render(index)}${insertion < source.length || source.endsWith('\n') ? eol : ''}` };
            return apply([edit]);
        }
        if (!isScalar(pair.key) || !pair.key.range) { throw new Error('Metadata field has no source range'); }
        if (index === path.length - 1) {
            if (!isScalar(pair.value) && pair.value !== null) { throw new Error('Metadata field must be scalar'); }
            if (value === null) {
                const valueEnd = isScalar(pair.value) && pair.value.range ? pair.value.range[2] : lineEnd(source, pair.key.range[1]);
                if (map?.flow && map.range) {
                    const position = map.items.indexOf(pair);
                    const next = map.items[position + 1]?.key;
                    const nextStart = isScalar(next) && next.range ? next.range[0] : undefined;
                    const start = position === map.items.length - 1 && position > 0 ? source.lastIndexOf(',', pair.key.range[0]) : pair.key.range[0];
                    const end = nextStart ?? (isScalar(pair.value) && pair.value.range ? pair.value.range[1] : pair.key.range[1] + 1);
                    return apply([{ range: { start, end }, text: '' }]);
                }
                const start = source.lastIndexOf('\n', pair.key.range[0] - 1) + 1;
                const edits: SourceEdit[] = [{ range: { start, end: valueEnd }, text: '' }];
                if (map?.items.length === 1 && parent && isScalar(parent.key) && parent.key.range) {
                    const colon = source.indexOf(':', parent.key.range[1]);
                    edits.push({ range: { start: colon + 1, end: colon + 1 }, text: ' {}' });
                }
                return apply(edits);
            }
            const adapter = ScenarioYamlDocument.parse(source); const field = adapter.findFieldAtPath(path);
            if (field) { return apply([fieldEdit(source, field, value, false, false)]); }
            if (!isScalar(pair.value) || !pair.value.range) { throw new Error('Metadata field has no source range'); }
            return apply([{ range: { start: pair.value.range[0], end: pair.value.range[1] }, text: typeof value === 'string' ? JSON.stringify(value) : String(value) }]);
        }
        if (!isMap(pair.value)) { throw new Error('Metadata parent must be a mapping'); }
        map = pair.value; parent = pair;
        const first = map.items[0]?.key;
        if (!map.range) { throw new Error('Metadata parent has no source range'); }
        indent = isScalar(first) && first.range ? lineIndent(source, first.range[0]) : lineIndent(source, pair.key.range[0]) + '  ';
        insertion = map.range[2];
    }
    return source;
}
