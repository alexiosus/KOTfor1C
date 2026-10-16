import { readScenarioProperties, addScenarioPropertyRecord } from './scenarioPropertiesModel';
import { parseScenarioParameterDefinitions } from './scenarioParameterUtils';

/** An explicit source-to-settings edit; blank overrides and authored settings stay intact. */
export function fillMissingCompilerProcessDefaults(source: string, settings: string): { text: string; added: string[] } {
    const process = readScenarioProperties(source);
    const test = readScenarioProperties(settings);
    const uid = (model: typeof process, key: string) => model.header.find(field => field.key === key)?.value.trim().toLowerCase();
    if (process.kind !== 'process' || test.kind !== 'processTest' || !uid(process, 'UID') || uid(process, 'UID') !== uid(test, 'UIDПроцесса')) {
        throw new Error('Choose settings linked to this process.');
    }
    const existing = new Set((test.sections.find(section => section.key === 'ПараметрыТеста')?.records ?? [])
        .map(record => record.fields.find(field => field.key === 'Имя')?.value.trim().toLowerCase()));
    const defaults = parseScenarioParameterDefinitions(source);
    const added: string[] = [];
    let text = settings;
    for (const record of process.sections.find(section => section.key === 'ПараметрыСценария')?.records ?? []) {
        const name = record.fields.find(field => field.key === 'Имя')?.value.trim() ?? '';
        if (!name || existing.has(name.toLowerCase())) { continue; }
        const definition = defaults.get(name);
        if (!definition) { throw new Error('The process parameter name is invalid.'); }
        let value = definition.value;
        const raw = definition.rawDefaultValue?.trim();
        // Match the external reader: it decodes only escaped quotes and backslashes,
        // rather than YAML's \n/\t escapes or doubled single quotes.
        if (definition.type !== 'table' && raw && /^(?:"[\s\S]*"|'[\s\S]*')$/u.test(raw)) {
            value = raw.slice(1, -1).replace(/\\"/gu, '"').replace(/\\\\/gu, '\\');
        }
        const fields: Record<string, string> = { Имя: name };
        for (const field of record.fields) {
            if (['ТипПараметра', 'ИсходящийПараметр', 'НесколькоЗначений'].includes(field.key) && field.value) { fields[field.key] = field.value; }
        }
        fields.Значение = value;
        text = addScenarioPropertyRecord(text, { section: 'ПараметрыТеста' }, fields);
        existing.add(name.toLowerCase()); added.push(name);
    }
    return { text, added };
}
