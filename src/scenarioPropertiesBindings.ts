import { ScenarioYamlDocument } from './scenarioYamlDocument';

export interface ScenarioPropertiesSource { readonly uri: string; readonly text: string }

/** Compiler settings are linked by UID; filenames and display names aren't identities. */
export function findLinkedScenarioSettings(source: ScenarioPropertiesSource, candidates: readonly ScenarioPropertiesSource[],
    parse: (source: ScenarioPropertiesSource) => ScenarioYamlDocument = source => ScenarioYamlDocument.parse(source.text)
): ScenarioPropertiesSource[] {
    const descriptor = parse(source);
    descriptor.requireValidForEdit();
    const type = descriptor.findFieldAtPath(['ТипФайла']);
    if (type?.ambiguous) { throw new Error(`Ambiguous source type: ${source.uri}`); }
    const process = String(type?.value ?? '').trim().toLowerCase() === 'процесс'
        || !type && descriptor.findFieldAtPath(['ДанныеПроцесса'])?.valueKind === 'mapping';
    const uid = descriptor.findField(process ? 'ДанныеПроцесса' : 'ДанныеСценария', 'UID');
    if (uid?.ambiguous) { throw new Error(`Ambiguous source UID: ${source.uri}`); }
    const identity = String(uid?.value ?? '').trim().toLowerCase();
    if (!identity) { return []; }
    return candidates.filter(candidate => {
        const settings = parse(candidate);
        const fileType = settings.findFieldAtPath(['ТипФайла']);
        const expectedType = process ? 'настройкапроцесса' : 'настройкатеста';
        if (String(fileType?.value ?? '').trim().toLowerCase() !== expectedType) { return false; }
        const link = settings.findField('ДанныеТеста', process ? 'UIDПроцесса' : 'UIDСценария');
        if (fileType?.ambiguous || link?.ambiguous) { throw new Error(`Ambiguous settings linkage: ${candidate.uri}`); }
        if (String(link?.value ?? '').trim().toLowerCase() !== identity) { return false; }
        settings.requireValidForEdit();
        return true;
    });
}

export function selectScenarioSettings(settings: readonly Pick<ScenarioPropertiesSource, 'uri'>[], previous?: string): string | undefined {
    if (previous && settings.some(value => value.uri === previous)) { return previous; }
    return settings.length === 1 ? settings[0].uri : undefined;
}
