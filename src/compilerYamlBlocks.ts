import { getSectionInsertionForSection, ScenarioYamlDocument, type ScenarioYamlSection } from './scenarioYamlDocument';

export type CompilerYamlBlockSection = 'ПараметрыСценария' | 'ПараметрыТеста' | 'ПараметрыШага' | 'ТегиСценария' | 'ТегиПроцесса' | 'ТегиТеста';
export interface CompilerYamlBlockTarget { section: CompilerYamlBlockSection; stepUid?: string }
export interface CompilerYamlBlockAction extends CompilerYamlBlockTarget { line: number }

interface BlockSection { target: CompilerYamlBlockTarget; section: ScenarioYamlSection }

function sectionsForEdit(source: string): BlockSection[] {
    const document = ScenarioYamlDocument.parse(source); document.requireValidForEdit();
    const type = document.findFieldAtPath(['ТипФайла']);
    if (type?.ambiguous) { throw new Error('Ambiguous file type'); }
    const kind = String(type?.value || '').trim().toLowerCase();
    const rootSections: CompilerYamlBlockSection[] = kind === 'сценарий' ? ['ПараметрыСценария', 'ТегиСценария']
        : kind === 'процесс' ? ['ПараметрыСценария', 'ТегиПроцесса']
            : kind === 'настройкатеста' || kind === 'настройкапроцесса' ? ['ПараметрыТеста', 'ТегиТеста'] : [];
    const sections: BlockSection[] = [];
    for (const name of rootSections) {
        document.findRecordFieldsForEdit(name, 'Имя');
        const section = document.findSection(name);
        if (section) { sections.push({ target: { section: name }, section }); }
    }
    if (kind === 'процесс') {
        document.findRecordFieldsForEdit('ШагиПроцесса', 'UID');
        document.findRecordFieldsForEdit('ШагиПроцесса', 'ПараметрыШага');
        const steps = document.readRecords('ШагиПроцесса');
        const uidCounts = new Map<string, number>();
        for (const step of steps) {
            const uid = String(step.fields.get('UID') || '').trim().toLowerCase();
            uidCounts.set(uid, (uidCounts.get(uid) || 0) + 1);
        }
        for (const [index, step] of steps.entries()) {
            const uid = String(step.fields.get('UID') || '').trim();
            if (!uid || uidCounts.get(uid.toLowerCase()) !== 1) { continue; }
            const section = document.findRecordSection('ШагиПроцесса', index, 'ПараметрыШага');
            if (section) {
                ScenarioYamlDocument.parse(source.slice(section.pairRange.start, section.pairRange.end)).findRecordFieldsForEdit('ПараметрыШага', 'Имя');
                sections.push({ target: { section: 'ПараметрыШага', stepUid: uid }, section });
            }
        }
    }
    return sections;
}

export function buildCompilerYamlBlockActions(source: string): CompilerYamlBlockAction[] {
    try {
        const sections = sectionsForEdit(source);
        const lineStarts = [0, ...Array.from(source.matchAll(/\r\n|\r|\n/gu), match => match.index + match[0].length)];
        return sections.map(({ target, section }) => {
            let low = 0; let high = lineStarts.length;
            while (low < high) {
                const middle = Math.floor((low + high) / 2);
                if (lineStarts[middle] <= section.pairRange.start) { low = middle + 1; } else { high = middle; }
            }
            return { ...target, line: low - 1 };
        });
    } catch { return []; }
}

export function validateCompilerYamlBlockName(section: CompilerYamlBlockSection, name: string): boolean {
    return section.startsWith('Теги') ? Boolean(name.trim()) && !/[\s@]/u.test(name) : /^[A-Za-zА-Яа-яЁё0-9_-]+$/u.test(name);
}

export function appendCompilerYamlBlock(source: string, target: CompilerYamlBlockTarget, name: string): string {
    if (!validateCompilerYamlBlockName(target.section, name)) { throw new Error('Invalid parameter or tag name'); }
    const available = sectionsForEdit(source);
    const found = available.find(item => item.target.section === target.section && item.target.stepUid === target.stepUid);
    if (!found) { throw new Error('Missing or ambiguous YAML block section'); }
    const scoped = ScenarioYamlDocument.parse(source.slice(found.section.pairRange.start, found.section.pairRange.end));
    const records = scoped.readRecords(target.section);
    if (records.some(record => String(record.fields.get('Имя') || '').trim().toLowerCase() === name.toLowerCase())) { throw new Error('Parameter or tag name already exists'); }
    let number = records.length + 1;
    for (const record of records) {
        const keyNumber = Number(record.key.slice(target.section.length));
        const rowNumber = Number(record.fields.get('НомерСтроки'));
        for (const existing of [keyNumber, rowNumber]) { if (Number.isSafeInteger(existing) && existing >= number) { number = existing + 1; } }
    }
    const lines = [`- ${target.section}${number}:`];
    const field = (key: string, value: string) => `    ${key}: ${JSON.stringify(value)}`;
    if (target.section !== 'ПараметрыШага') { lines.push(field('НомерСтроки', String(number))); }
    lines.push(field('Имя', name));
    if (!target.section.startsWith('Теги')) {
        if (target.section === 'ПараметрыШага') {
            lines.push(field('ТипПараметра', 'Строка'), field('ШагПроцессаЗначениеПоСсылке', ''), field('ШагПроцессаЗначениеПоСсылкеUID', ''),
                field('ИсходящийПараметр', 'Нет'), field('ЗначениеПоСсылке', ''), field('ЗначениеПроизвольное', ''), field('ИмяПараметраПоСсылке', ''));
        } else {
            lines.push(field('Значение', ''), field('ТипПараметра', 'Строка'), field('ИсходящийПараметр', 'Нет'), field('НесколькоЗначений', 'Нет'));
        }
    }
    const edit = getSectionInsertionForSection(source, found.section, lines.join('\n'));
    const updated = source.slice(0, edit.range.start) + edit.text + source.slice(edit.range.end);
    ScenarioYamlDocument.parse(updated).requireValidForEdit();
    return updated;
}
