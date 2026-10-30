import { ScenarioYamlDocument } from './scenarioYamlDocument';

export interface ScenarioTestSettingsValues { uid: string; databaseName: string; databaseId: string; userProfile: string }

/** Settings get their own identity and the compiler's actual descriptor UID link. */
export function buildScenarioTestSettings(source: string, values: ScenarioTestSettingsValues): string {
    const document = ScenarioYamlDocument.parse(source); document.requireValidForEdit();
    const type = document.findFieldAtPath(['ТипФайла']);
    if (type?.ambiguous) { throw new Error('Ambiguous source file type.'); }
    const process = String(type?.value ?? '').trim().toLowerCase() === 'процесс';
    if (!process && String(type?.value ?? '').trim().toLowerCase() !== 'сценарий') { throw new Error('Choose a scenario or process.'); }
    const section = process ? 'ДанныеПроцесса' : 'ДанныеСценария';
    const read = (key: string): string => {
        const field = document.findField(section, key);
        if (field?.ambiguous) { throw new Error(`Ambiguous source ${key}.`); }
        return String(field?.value ?? '').trim();
    };
    const uid = read('UID'); const name = read('Имя'); const code = read('Код');
    if (!uid || !name || !values.uid || !values.databaseId) { throw new Error('Source UID, name and selected infobase are required.'); }
    const field = (key: string, value: string) => `    ${key}: ${JSON.stringify(value)}`;
    const eol = source.includes('\r\n') ? '\r\n' : '\n';
    return [`ТипФайла: "${process ? 'НастройкаПроцесса' : 'НастройкаТеста'}"`, 'ДанныеТеста:',
        field('UID', values.uid), field('Код', code || name), field('Имя', name),
        field(process ? 'UIDПроцесса' : 'UIDСценария', uid),
        field(process ? 'ПроцессНаименование' : 'СценарийНаименование', name),
        field('ЭталоннаяБазаИмя', values.databaseName), field('ИдентификаторБазы', values.databaseId),
        field('ПрофильПользователя', values.userProfile), field('ПараметрыЗапуска', ''),
        '', 'ПараметрыТеста:', '', 'ТегиТеста:', ''].join(eol);
}
