import { ScenarioYamlDocument, type SourceEdit } from './scenarioYamlDocument';
import { updateNestedScenarioNameReferencesInScenarioContent, updateScenarioDisplayNameInScenarioContent } from './scenarioYamlMutations';

export interface ScenarioPropertyIdentityChange { uid: string; oldName: string; oldCode: string; field: 'name' | 'code'; value: string }
export interface ScenarioIdentityChangeResult {
    readonly sourceUri: string;
    readonly uriMoves: readonly { readonly oldUri: string; readonly newUri: string }[];
}

/** Inline fields change one identity value; UID-linked variant names/codes remain independent. */
export function applyScenarioPropertyIdentity(source: string, change: ScenarioPropertyIdentityChange): string {
    let text = source;
    const document = ScenarioYamlDocument.parse(source); document.requireValidForEdit();
    const uid = change.uid.trim().toLowerCase();
    if (!uid || !change.value.trim() || /[\r\n\0]/u.test(change.value)) { throw new Error('Enter a nonempty single-line identity value.'); }
    const sameUid = (value: unknown) => String(value ?? '').trim().toLowerCase() === uid;
    const self = sameUid(document.readScalar('ДанныеСценария', 'UID'));
    if (self) {
        text = updateScenarioDisplayNameInScenarioContent(text, change.field === 'name' ? change.value : change.oldName,
            change.field === 'code' ? change.value : undefined).content;
    }
    const fileType = document.findFieldAtPath(['ТипФайла']);
    if (fileType?.ambiguous) { throw new Error('Ambiguous identity source type.'); }
    const scenarioHeader = document.findFieldAtPath(['ДанныеСценария']);
    const scenarioName = document.findField('ДанныеСценария', 'Имя');
    if (!fileType && (scenarioHeader?.ambiguous || scenarioName?.ambiguous || document.findField('ДанныеСценария', 'UID')?.ambiguous)) {
        throw new Error('Ambiguous legacy scenario header.');
    }
    const legacyScenario = !fileType && scenarioHeader?.valueKind === 'mapping'
        && typeof scenarioName?.value === 'string' && !!scenarioName.value.trim() && !document.findSection('ДанныеПроцесса');
    if (change.field === 'name' && (String(fileType?.value ?? '').trim().toLowerCase() === 'сценарий' || legacyScenario)) {
        text = updateNestedScenarioNameReferencesInScenarioContent(text, change.oldName, change.value).content;
    }
    const updated = ScenarioYamlDocument.parse(text); updated.requireValidForEdit();
    const edits: SourceEdit[] = [];
    const set = (field: ReturnType<ScenarioYamlDocument['findField']>, value: string) => {
        if (!field) { return; }
        if (field.ambiguous || field.valueKind !== 'scalar' || !field.valueRange) { throw new Error('Ambiguous identity reference field.'); }
        edits.push({ range: field.valueRange, text: JSON.stringify(value) });
    };
    if (sameUid(updated.readScalar('ДанныеТеста', 'UIDСценария'))) {
        if (change.field === 'name') {
            set(updated.findField('ДанныеТеста', 'СценарийНаименование'), change.value);
            if (updated.readScalar('ДанныеТеста', 'Имя') === change.oldName) { set(updated.findField('ДанныеТеста', 'Имя'), change.value); }
        } else if (updated.readScalar('ДанныеТеста', 'Код') === change.oldCode) { set(updated.findField('ДанныеТеста', 'Код'), change.value); }
    }
    for (const step of updated.readRecords('ШагиПроцесса')) {
        if (String(step.fields.get('ТипШага') ?? '0') !== '0' || !sameUid(step.fields.get('СценарийUID') || step.fields.get('Сценарий'))) { continue; }
        const field = (key: string) => updated.findRecordFieldsForEdit('ШагиПроцесса', key).find(field => field.pairRange.start >= step.range.start && field.pairRange.start <= step.range.end) ?? null;
        if (change.field === 'name') {
            set(field('СценарийНаименование'), change.value);
            if (step.fields.get('Наименование') === change.oldName) { set(field('Наименование'), change.value); }
            else {
                const name = String(step.fields.get('Наименование') ?? '');
                const suffix = name.startsWith(change.oldName) ? name.slice(change.oldName.length) : '';
                if (/^ \(\d+\)$/u.test(suffix)) { set(field('Наименование'), change.value + suffix); }
            }
        } else { set(field('СценарийКод'), change.value); }
    }
    text = edits.sort((left, right) => right.range.start - left.range.start).reduce((text, edit) => text.slice(0, edit.range.start) + edit.text + text.slice(edit.range.end), text);
    ScenarioYamlDocument.parse(text).requireValidForEdit();
    return text;
}
