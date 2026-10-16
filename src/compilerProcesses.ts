import {
    getSectionInsertion,
    ScenarioYamlDocument,
    type ScenarioYamlField,
    type SourceEdit
} from './scenarioYamlDocument';
import type { ProcessStepReference } from './types';
import { isMap, isScalar, parseDocument } from 'yaml';

export interface CompilerProcessParameter {
    name: string;
    value: string;
    type: string;
    outgoing: boolean;
}

export interface CompilerProcessScenario {
    kind?: 'scenario' | 'process';
    name: string;
    uid?: string;
    scenarioCode?: string;
    parameters?: readonly CompilerProcessParameter[];
}

export interface CompilerProcessCreationOptions {
    name: string;
    code: string;
    fullCode?: string;
    uid: string;
    settingsUid: string;
    project: string;
    userProfile: string;
    databaseId: string;
    databaseName?: string;
    reportLevel1: string;
    reportLevel2: string;
    steps: readonly { scenario: CompilerProcessScenario; uid: string }[];
}

export interface CompilerProcessFiles {
    processSource: string;
    settingsSource: string;
}

function quote(value: string): string {
    if (/[\r\n]/.test(value)) {
        throw new Error('Compiler YAML scalar values must fit on one line');
    }
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function field(name: string, value: string, indent = 4): string {
    return `${' '.repeat(indent)}${name}: ${quote(value)}`;
}

function requireIdentity(value: string | undefined, name: string): string {
    if (!value?.trim()) {
        throw new Error(`Missing ${name}`);
    }
    return value.trim();
}

function buildStep(
    scenario: CompilerProcessScenario,
    stepUid: string,
    processUid: string,
    fullCode: string,
    index: number,
    userProfile: string,
    stepName = scenario.name
): string {
    const isProcess = scenario.kind === 'process';
    const scenarioUid = requireIdentity(scenario.uid, isProcess ? 'nested process UID' : 'scenario UID');
    if (isProcess && scenarioUid.toLowerCase() === processUid.toLowerCase()) { throw new Error('A process cannot contain itself'); }
    requireIdentity(scenario.name, 'scenario name');
    requireIdentity(stepUid, 'step UID');
    const lines = [
        `- ШагиПроцесса${index + 1}:`,
        field('ШагПроцесса', stepUid),
        field('UID', stepUid),
        field('Процесс', processUid),
        field('Наименование', stepName),
        ...(!isProcess ? [
            field('Сценарий', scenarioUid), field('СценарийНаименование', scenario.name),
            field('СценарийКод', requireIdentity(scenario.scenarioCode, 'scenario code')), field('СценарийUID', scenarioUid)
        ] : []),
        field('ПолныйКод', `${fullCode}.${index + 1}`),
        field('ИсполнительНаименование', userProfile),
        '    ПараметрыШага:'
    ];
    for (const [parameterIndex, parameter] of (scenario.parameters ?? []).entries()) {
        lines.push(
            `        - ПараметрыШага${parameterIndex + 1}:`,
            field('Имя', parameter.name, 12),
            field('ТипПараметра', parameter.type, 12),
            field('ШагПроцессаЗначениеПоСсылке', '', 12),
            field('ШагПроцессаЗначениеПоСсылкеUID', '', 12),
            field('ИсходящийПараметр', parameter.outgoing ? 'Да' : 'Нет', 12),
            field('ЗначениеПоСсылке', '', 12)
        );
        if (/[\r\n]/.test(parameter.value)) {
            lines.push(
                '            ЗначениеПроизвольное: |',
                ...parameter.value.replace(/\r\n?/g, '\n').split('\n').map(line => `                ${line}`)
            );
        } else {
            lines.push(field('ЗначениеПроизвольное', parameter.value, 12));
        }
        // The compiler uses this field to terminate multiline parameter values.
        lines.push(field('ИмяПараметраПоСсылке', '', 12));
    }
    lines.push(
        field('ТипШага', isProcess ? '1' : '0'),
        ...(isProcess ? [field('ВложенныйПроцессНаименование', scenario.name), field('ВложенныйПроцессUID', scenarioUid)] : [])
    );
    return lines.join('\n');
}

/** Emits the compiler's four-space record format and quoted scalar values. */
export function buildCompilerProcessFiles(options: CompilerProcessCreationOptions): CompilerProcessFiles {
    const uid = requireIdentity(options.uid, 'process UID');
    const code = requireIdentity(options.code, 'process code');
    const name = requireIdentity(options.name, 'process name');
    requireIdentity(options.settingsUid, 'settings UID');
    requireIdentity(options.databaseId, 'database identifier');
    const fullCode = options.fullCode?.trim() || code;
    const names = new Set<string>();
    const uids = new Set<string>();
    const steps = options.steps.map((step, index) => {
        if (uids.has(step.uid)) {
            throw new Error('Duplicate step UID');
        }
        uids.add(step.uid);
        let stepName = step.scenario.name;
        let occurrence = 1;
        while (names.has(stepName)) {
            occurrence += 1;
            stepName = `${step.scenario.name} (${occurrence})`;
        }
        names.add(stepName);
        return buildStep(step.scenario, step.uid, uid, fullCode, index, options.userProfile, stepName)
            .split('\n').map(line => `    ${line}`).join('\n');
    });
    return {
        processSource: [
            'ТипФайла: "Процесс"',
            'ДанныеПроцесса:',
            field('UID', uid), field('Имя', name), field('Код', code), field('ПолныйКод', fullCode),
            field('ВерсияСценария', '1'), field('Проект', options.project), field('ПрофильПользователя', options.userProfile),
            field('Ответственный', ''), field('УровеньОтчета1', options.reportLevel1), field('УровеньОтчета2', options.reportLevel2),
            '', 'ПараметрыСценария:', '', 'ШагиПроцесса:', ...steps, '', 'ТегиПроцесса:', ''
        ].join('\n'),
        settingsSource: [
            'ТипФайла: "НастройкаПроцесса"', 'ДанныеТеста:',
            field('UID', options.settingsUid), field('Код', code), field('Имя', name), field('UIDПроцесса', uid),
            field('ПроцессНаименование', name),
            ...(options.databaseName ? [field('ЭталоннаяБазаИмя', options.databaseName)] : []),
            field('ИдентификаторБазы', options.databaseId),
            field('ПрофильПользователя', options.userProfile), field('ПараметрыЗапуска', ''),
            '', 'ПараметрыТеста:', '', 'ТегиТеста:', ''
        ].join('\n')
    };
}

export function readCompilerProcessScenarioParameters(source: string): CompilerProcessParameter[] {
    return ScenarioYamlDocument.parse(source).readRecords('ПараметрыСценария').flatMap(record => {
        const name = record.fields.get('Имя');
        if (typeof name !== 'string' || !name.trim()) {
            return [];
        }
        return [{
            name: name.trim(),
            value: String(record.fields.get('Значение') ?? ''),
            type: String(record.fields.get('ТипПараметра') || 'Строка'),
            outgoing: String(record.fields.get('ИсходящийПараметр') ?? '').toLowerCase() === 'да'
        }];
    });
}

function editableDocument(source: string): ScenarioYamlDocument {
    const document = ScenarioYamlDocument.parse(source);
    document.requireValidForEdit();
    requireIdentity(document.readScalar('ДанныеПроцесса', 'UID'), 'process UID');
    document.findRecordFieldsForEdit('ШагиПроцесса', 'UID');
    document.findRecordFieldsForEdit('ШагиПроцесса', 'ПараметрыШага');
    const fields = ['UID', 'Код', 'ПолныйКод'].flatMap(name => {
        const field = document.findField('ДанныеПроцесса', name);
        return field ? [field] : [];
    }).concat(['UID', 'ШагПроцесса', 'ПолныйКод'].flatMap(name => document.findRecordFieldsForEdit('ШагиПроцесса', name)));
    for (const field of fields) {
        if (field.ambiguous) { throw new Error('Unsafe YAML edit: process structural fields and full codes must be single-line scalars'); }
        if (field.valueKind === 'null' || field.valueKind === 'missing') { continue; }
        const raw = field.valueRange ? source.slice(field.valueRange.start, field.valueRange.end) : '';
        const scalar = parseDocument(`value: ${raw}`, { prettyErrors: false });
        const value = isMap(scalar.contents) ? scalar.contents.items[0]?.value : undefined;
        if (field.ambiguous || !field.valueRange || field.valueKind !== 'scalar' || /[\r\n]/u.test(String(field.value))
            || scalar.errors.length > 0 || !isScalar(value)) {
            throw new Error('Unsafe YAML edit: process structural fields and full codes must be single-line scalars');
        }
    }
    return document;
}

function applyEdit(source: string, edit: SourceEdit): string {
    return source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end);
}

function renumberCompilerProcessSteps(source: string): string {
    const document = editableDocument(source);
    const records = document.readRecords('ШагиПроцесса');
    const fullCode = document.readScalar('ДанныеПроцесса', 'ПолныйКод') || document.readScalar('ДанныеПроцесса', 'Код');
    const edits: SourceEdit[] = records.map((record, index) => ({
        range: record.keyRange, text: `ШагиПроцесса${index + 1}`
    }));
    let recordIndex = 0;
    for (const field of document.findRecordFieldsForEdit('ШагиПроцесса', 'ПолныйКод')) {
        while (recordIndex < records.length && field.pairRange.start > records[recordIndex].range.end) { recordIndex += 1; }
        if (!fullCode || recordIndex >= records.length) { continue; }
        if (!field.valueRange || field.valueKind !== 'scalar') { throw new Error('Unsafe YAML edit: process step full code must be a scalar'); }
        edits.push({ range: field.valueRange, text: quote(`${fullCode}.${recordIndex + 1}`) });
    }
    return edits.sort((left, right) => right.range.start - left.range.start).reduce(applyEdit, source);
}

export function appendCompilerProcessScenarioStep(
    source: string,
    scenario: CompilerProcessScenario,
    stepUid: string
): string {
    const document = editableDocument(source);
    const existing = document.readRecords('ШагиПроцесса');
    if (existing.some(record => record.fields.get('UID') === stepUid)) {
        throw new Error('Duplicate step UID');
    }
    const keys = new Set(existing.map(record => record.key));
    let index = existing.length;
    while (keys.has(`ШагиПроцесса${index + 1}`)) {
        index += 1;
    }
    const names = new Set(existing.map(record => record.fields.get('Наименование')));
    let stepName = scenario.name;
    let occurrence = 1;
    while (names.has(stepName)) {
        occurrence += 1;
        stepName = `${scenario.name} (${occurrence})`;
    }
    const item = buildStep(
        scenario, stepUid,
        document.readScalar('ДанныеПроцесса', 'UID')!,
        document.readScalar('ДанныеПроцесса', 'ПолныйКод') || document.readScalar('ДанныеПроцесса', 'Код') || '',
        index, document.readScalar('ДанныеПроцесса', 'ПрофильПользователя') || '', stepName
    );
    const insertion = getSectionInsertion(source, 'ШагиПроцесса', item);
    if (insertion) {
        return renumberCompilerProcessSteps(applyEdit(source, insertion));
    }
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    return renumberCompilerProcessSteps(`${source}${source.endsWith(newline) ? '' : newline}ШагиПроцесса:${newline}`
        + item.split('\n').map(line => `    ${line}`).join(newline) + newline);
}

function stepChunks(source: string): { start: number; end: number; chunks: string[] } {
    const document = editableDocument(source);
    const records = document.readRecords('ШагиПроцесса');
    const section = document.findSection('ШагиПроцесса');
    if (!section || records.length === 0) {
        throw new Error('Process step index is out of range');
    }
    const starts = records.map(record => source.lastIndexOf('\n', record.range.start - 1) + 1);
    return {
        start: starts[0], end: section.bodyRange.end,
        chunks: starts.map((start, index) => source.slice(start, starts[index + 1] ?? section.bodyRange.end))
    };
}

function requireStepIndex(index: number, count: number): void {
    if (!Number.isInteger(index) || index < 0 || index >= count) {
        throw new Error('Process step index is out of range');
    }
}

export function moveCompilerProcessStep(source: string, fromIndex: number, toIndex: number): string {
    const { start, end, chunks } = stepChunks(source);
    requireStepIndex(fromIndex, chunks.length);
    requireStepIndex(toIndex, chunks.length);
    const [moved] = chunks.splice(fromIndex, 1);
    chunks.splice(toIndex, 0, moved);
    const newline = source.includes('\r\n') ? '\r\n' : '\n';
    const text = chunks.map((chunk, index) => index < chunks.length - 1 && !chunk.endsWith('\n')
        ? chunk + newline : chunk).join('');
    return renumberCompilerProcessSteps(applyEdit(source, { range: { start, end }, text }));
}

export function removeCompilerProcessStep(source: string, index: number): string {
    const { start, end, chunks } = stepChunks(source);
    requireStepIndex(index, chunks.length);
    const document = editableDocument(source);
    const records = document.readRecords('ШагиПроцесса');
    const identities = new Set([records[index].fields.get('UID'), records[index].fields.get('ШагПроцесса')]
        .map(value => String(value || '').trim().toLowerCase()).filter(Boolean));
    for (const [otherIndex] of records.entries()) {
        if (otherIndex === index) { continue; }
        const section = document.findRecordSection('ШагиПроцесса', otherIndex, 'ПараметрыШага');
        if (!section) { continue; }
        const parameters = ScenarioYamlDocument.parse(source.slice(section.pairRange.start, section.pairRange.end));
        parameters.findRecordFieldsForEdit('ПараметрыШага', 'ШагПроцессаЗначениеПоСсылкеUID');
        parameters.findRecordFieldsForEdit('ПараметрыШага', 'ШагПроцессаЗначениеПоСсылке');
        if (parameters.readRecords('ПараметрыШага').some(parameter => ['ШагПроцессаЗначениеПоСсылкеUID', 'ШагПроцессаЗначениеПоСсылке']
            .some(field => identities.has(String(parameter.fields.get(field) || '').trim().toLowerCase())))) {
            throw new Error('This process step supplies parameters to another step. Update the parameter links before deleting it.');
        }
    }
    chunks.splice(index, 1);
    return renumberCompilerProcessSteps(applyEdit(source, { range: { start, end }, text: chunks.join('') }));
}

export interface CompilerProcessIdentityChange {
    uid: string;
    oldName: string;
    name: string;
    oldCode?: string;
    code?: string;
}

/** Keep identity stable while updating the descriptor, UID-linked settings and parent steps. */
export function updateCompilerProcessIdentity(source: string, identity: CompilerProcessIdentityChange): string {
    const processUid = requireIdentity(identity.uid, 'process UID').toLowerCase();
    requireIdentity(identity.name, 'process name');
    const document = ScenarioYamlDocument.parse(source);
    document.requireValidForEdit();
    const sameUid = (value: unknown) => String(value ?? '').trim().toLowerCase() === processUid;
    const edits: SourceEdit[] = [];
    const setField = (field: ScenarioYamlField | null | undefined, value: string): void => {
        if (!field) { return; }
        if (field.ambiguous || field.valueKind !== 'scalar' || !field.valueRange) { throw new Error(`Unsafe YAML edit: ${field.key} must be one unambiguous scalar`); }
        edits.push({ range: field.valueRange, text: quote(value) });
    };
    const requiredField = (section: string, name: string): ScenarioYamlField => {
        const field = document.findField(section, name);
        if (!field) { throw new Error(`Unsafe YAML edit: required field ${section}.${name} is missing`); }
        return field;
    };
    const uid = document.findField('ДанныеПроцесса', 'UID');
    const isSelf = sameUid(uid?.value);
    if (isSelf) {
        if (uid?.ambiguous) { throw new Error('Ambiguous process UID'); }
        setField(requiredField('ДанныеПроцесса', 'Имя'), identity.name);
        if (identity.code !== undefined) {
            const currentCode = requireIdentity(document.readScalar('ДанныеПроцесса', 'Код'), 'ДанныеПроцесса.Код');
            const fullCode = document.readScalar('ДанныеПроцесса', 'ПолныйКод') || currentCode;
            const prefix = fullCode.endsWith(`.${currentCode}`) ? fullCode.slice(0, -currentCode.length) : '';
            setField(requiredField('ДанныеПроцесса', 'Код'), identity.code);
            setField(document.findField('ДанныеПроцесса', 'ПолныйКод'), prefix + identity.code);
        }
    }
    const settingsUid = document.findField('ДанныеТеста', 'UIDПроцесса');
    if (sameUid(settingsUid?.value)) {
        if (settingsUid?.ambiguous) { throw new Error('Ambiguous process settings UID'); }
        setField(requiredField('ДанныеТеста', 'ПроцессНаименование'), identity.name);
        if (document.readScalar('ДанныеТеста', 'Имя') === identity.oldName) { setField(document.findField('ДанныеТеста', 'Имя'), identity.name); }
        if (identity.code !== undefined && document.readScalar('ДанныеТеста', 'Код') === identity.oldCode) { setField(document.findField('ДанныеТеста', 'Код'), identity.code); }
    }
    const records = document.readRecords('ШагиПроцесса');
    const nestedUids = document.findRecordFieldsForEdit('ШагиПроцесса', 'ВложенныйПроцессUID');
    const nestedNames = document.findRecordFieldsForEdit('ШагиПроцесса', 'ВложенныйПроцессНаименование');
    const stepNames = document.findRecordFieldsForEdit('ШагиПроцесса', 'Наименование');
    for (const record of records) {
        const fieldInRecord = (fields: readonly ScenarioYamlField[]) => fields.find(field => field.pairRange.start >= record.range.start && field.pairRange.start <= record.range.end);
        if (String(record.fields.get('ТипШага')) !== '1' || !sameUid(fieldInRecord(nestedUids)?.value)) { continue; }
        setField(fieldInRecord(nestedNames), identity.name);
        const stepName = fieldInRecord(stepNames);
        if (stepName?.value === identity.oldName) { setField(stepName, identity.name); }
        else if (typeof stepName?.value === 'string' && stepName.value.startsWith(identity.oldName + ' ')) {
            const suffix = stepName.value.slice(identity.oldName.length);
            if (/^ \(\d+\)$/u.test(suffix)) { setField(stepName, identity.name + suffix); }
        }
    }
    const updated = edits.sort((left, right) => right.range.start - left.range.start).reduce(applyEdit, source);
    return isSelf && identity.code !== undefined ? renumberCompilerProcessSteps(updated) : updated;
}


/** Reject self references, paths back to the parent, and cycles already present in a candidate. */
export function canEmbedCompilerProcess(
    parentUid: string | undefined,
    candidateUid: string,
    processes: readonly { uid?: string; processSteps?: readonly ProcessStepReference[] }[]
): boolean {
    const normalize = (uid: string) => uid.trim().toLowerCase();
    const byUid = new Map<string, typeof processes[number][]>();
    for (const process of processes) {
        if (!process.uid) { continue; }
        const uid = normalize(process.uid);
        byUid.set(uid, [...(byUid.get(uid) ?? []), process]);
    }
    const active = new Set<string>(); const visited = new Set<string>();
    const visit = (uid: string): boolean => {
        const key = normalize(uid);
        if ((parentUid && key === normalize(parentUid)) || active.has(key)) { return false; }
        if (visited.has(key)) { return true; }
        const definitions = byUid.get(key);
        if (!definitions || definitions.length !== 1) { return false; }
        active.add(key);
        for (const step of definitions[0].processSteps ?? []) {
            if (step.type === 'process' && (!step.processUid || !visit(step.processUid))) { return false; }
        }
        active.delete(key); visited.add(key);
        return true;
    };
    return visit(candidateUid);
}
