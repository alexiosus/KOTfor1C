import fs from 'node:fs/promises';
import path from 'node:path';
import { VANESSA_PARAMETER_CATALOG } from './vanessaParameterCatalog.generated';
import { parseVanessaParameterDocumentation, parseVanessaParameterSources, type VanessaParameterDefinition } from './vanessaParameterParser';
import { getVanessaParameterAliases } from './vanessaLaunchJson';
import { extractVanessaVersionFromChangelog } from './vanessaVersion';
import { resolveWorkspaceOwnedPath } from './workspaceArtifactPath';

export interface VanessaParameterCatalogSnapshot {
    definitions: readonly VanessaParameterDefinition[];
    authoritative: boolean;
    version?: string;
    source?: 'sources' | 'documentation' | 'bundled';
}

export function createVanessaParameterFieldDefinitions(definitions: readonly VanessaParameterDefinition[], authoritative = false) {
    const names = (entry: VanessaParameterDefinition) => [...new Set([entry.key, ...entry.aliases, ...getVanessaParameterAliases(entry.key),
        ...getVanessaParameterAliases(entry.key.split('.').at(-1)!), ...entry.aliases.flatMap(alias => getVanessaParameterAliases(alias.split('.').at(-1)!))])];
    const available = new Set(definitions.flatMap(names).map(key => key.toLocaleLowerCase()));
    // Release documentation can omit valid settings. Keep hints for stored rows without claiming support.
    const missing = VANESSA_PARAMETER_CATALOG.filter(entry => !names(entry).some(key => available.has(key.toLocaleLowerCase())));
    const fields = [...definitions, ...missing].map((entry, index) => ({
        keys: names(entry), keyOptions: [...new Set([entry.key, ...entry.aliases, ...getVanessaParameterAliases(entry.key)])],
        valueKind: entry.valueKind, aliases: entry.aliases,
        description: entry.description === (entry.aliases[0] ?? entry.key)
            ? VANESSA_PARAMETER_CATALOG.find(known => known.key === entry.key)?.description ?? entry.description : entry.description,
        availability: !authoritative ? 'unverified' as const : index < definitions.length ? 'supported' as const : 'unsupported' as const
    }));
    const kinds = new Map<string, Set<string>>();
    for (const entry of fields) {
        for (const key of entry.keys) {
            const set = kinds.get(key.toLocaleLowerCase()) ?? new Set(); set.add(entry.valueKind); kinds.set(key.toLocaleLowerCase(), set);
        }
    }
    return fields.map(entry => ({ ...entry, keys: entry.keys.filter(key => kinds.get(key.toLocaleLowerCase())!.size === 1) }));
}

/** Prefer local source declarations, then release documentation; never inspect or execute the EPF binary. */
export async function loadVanessaParameterCatalogSnapshot(folder: string, workspaceRoot?: string | null): Promise<VanessaParameterCatalogSnapshot> {
    if (workspaceRoot && folder) { folder = resolveWorkspaceOwnedPath(workspaceRoot, folder) ?? ''; }
    if (folder) {
        const root = /\.epf$/iu.test(folder) ? path.dirname(folder) : folder;
        for (const source of [root, path.join(root, 'VanessaAutomation')]) {
            try {
                const [object, form, documentation] = await Promise.all([
                    fs.readFile(path.join(source, 'Ext/ObjectModule.bsl'), 'utf8'),
                    fs.readFile(path.join(source, 'Forms/УправляемаяФорма/Ext/Form/Module.bsl'), 'utf8'),
                    fs.readFile(path.join(root, 'docs/JsonParams/JsonParamsRU.md'), 'utf8').catch(() => '')
                ]);
                const entries = parseVanessaParameterSources(object, form, documentation);
                if (entries.length) {
                    const version = /Функция\s+ПолучитьВерсиюОбработки\([^]*?\n\s*Версия\s*=\s*"([\d.]+)"/iu.exec(object)?.[1];
                    return { definitions: entries, authoritative: true, source: 'sources', ...(version ? { version } : {}) };
                }
            } catch (error) {
                if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
            }
        }
        for (const language of ['RU', 'EN']) {
            try {
                const documentation = await fs.readFile(path.join(root, `docs/JsonParams/JsonParams${language}.md`), 'utf8');
                const entries = parseVanessaParameterDocumentation(documentation).map(entry => {
                    const matches = VANESSA_PARAMETER_CATALOG.filter(known => [known.key, ...known.aliases].some(key =>
                        [entry.key, ...entry.aliases].some(name => name.toLocaleLowerCase() === key.toLocaleLowerCase() || name.toLocaleLowerCase() === key.split('.').at(-1)!.toLocaleLowerCase())));
                    const known = matches.length === 1 ? matches[0] : undefined;
                    return known ? { ...known, description: entry.description } : entry;
                });
                if (entries.length) {
                    const changelog = await fs.readFile(path.join(root, 'docs/Changelog.md'), 'utf8').catch(() => '');
                    const version = extractVanessaVersionFromChangelog(changelog);
                    return { definitions: [...new Map(entries.map(entry => [entry.key, entry])).values()], authoritative: false,
                        source: 'documentation', ...(version ? { version } : {}) };
                }
            } catch (error) {
                if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { throw error; }
            }
        }
    }
    return { definitions: VANESSA_PARAMETER_CATALOG, authoritative: false, source: 'bundled' };
}

export async function loadVanessaParameterCatalog(folder: string): Promise<readonly VanessaParameterDefinition[]> {
    return (await loadVanessaParameterCatalogSnapshot(folder)).definitions;
}
