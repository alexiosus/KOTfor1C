import { ScenarioYamlDocument } from './scenarioYamlDocument';

export interface CompilerBuildSource { readonly uri: string; readonly text: string }

/** Includes root settings and reachable definitions, rather than unrelated nested test settings. */
export function selectCompilerBuildSources(sources: readonly CompilerBuildSource[], enabledRootUris: readonly string[]): CompilerBuildSource[] {
    const unique = new Map(sources.map(source => [source.uri, source]));
    const parsed = new Map([...unique.values()].map(source => [source.uri, ScenarioYamlDocument.parse(source.text)]));
    const value = (document: ScenarioYamlDocument, section: string, key: string) => String(document.findField(section, key)?.value ?? '').trim().toLowerCase();
    const kind = (document: ScenarioYamlDocument) => String(document.findFieldAtPath(['ТипФайла'])?.value ?? '').trim().toLowerCase();
    const definitions = [...unique.values()].filter(source => ['сценарий', 'процесс'].includes(kind(parsed.get(source.uri)!)));
    const byUid = new Map<string, CompilerBuildSource[]>();
    const byName = new Map<string, CompilerBuildSource[]>();
    for (const source of definitions) {
        const document = parsed.get(source.uri)!;
        const type = kind(document); const section = type === 'процесс' ? 'ДанныеПроцесса' : 'ДанныеСценария';
        for (const [key, index] of [['UID', byUid], ['Имя', byName]] as const) {
            const identity = value(document, section, key);
            if (identity) { const key = `${type}:${identity}`; index.set(key, [...index.get(key) ?? [], source]); }
        }
    }
    const rootIdentities = new Set<string>();
    const selected = new Set(enabledRootUris.filter(uri => unique.has(uri)));
    const queue = [...selected];
    for (const uri of [...queue]) {
        const document = parsed.get(uri)!;
        const process = kind(document) === 'процесс';
        const uid = value(document, process ? 'ДанныеПроцесса' : 'ДанныеСценария', 'UID');
        rootIdentities.add(`${process ? 'process' : 'scenario'}:${uid}`);
        for (const duplicate of byUid.get(`${kind(document)}:${uid}`) ?? []) {
            if (!selected.has(duplicate.uri)) { selected.add(duplicate.uri); queue.push(duplicate.uri); }
        }
    }
    for (let index = 0; index < queue.length; index++) {
        const document = parsed.get(queue[index])!;
        const references: Array<{ type: string; uid: string; name: string }> = [];
        for (const record of document.readRecords('ВложенныеСценарии')) {
            references.push({ type: 'сценарий', uid: String(record.fields.get('UIDВложенныйСценарий') ?? '').trim().toLowerCase(),
                name: String(record.fields.get('ИмяСценария') ?? record.fields.get('Имя') ?? '').trim().toLowerCase() });
        }
        for (const record of document.readRecords('ШагиПроцесса')) {
            const process = Number(record.fields.get('ТипШага') ?? 0) === 1;
            references.push({ type: process ? 'процесс' : 'сценарий',
                uid: String(record.fields.get(process ? 'ВложенныйПроцессUID' : 'СценарийUID') ?? record.fields.get('Сценарий') ?? '').trim().toLowerCase(),
                name: String(record.fields.get(process ? 'ВложенныйПроцессНаименование' : 'СценарийНаименование') ?? '').trim().toLowerCase() });
        }
        for (const reference of references) {
            const targets = reference.uid ? byUid.get(`${reference.type}:${reference.uid}`) : byName.get(`${reference.type}:${reference.name}`);
            for (const source of targets ?? []) {
                if (!selected.has(source.uri)) { selected.add(source.uri); queue.push(source.uri); }
            }
        }
    }
    for (const source of unique.values()) {
        const document = parsed.get(source.uri)!;
        const process = kind(document) === 'настройкапроцесса';
        if (![ 'настройкатеста', 'настройкапроцесса' ].includes(kind(document))) { continue; }
        const uid = value(document, 'ДанныеТеста', process ? 'UIDПроцесса' : 'UIDСценария');
        if (uid && rootIdentities.has(`${process ? 'process' : 'scenario'}:${uid}`)) { selected.add(source.uri); }
    }
    return [...selected].map(uri => unique.get(uri)!);
}
