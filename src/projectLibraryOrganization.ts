import { projectFormat } from './projectFormat';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseDocument, stringify, visit } from 'yaml';
import type { ProjectGroup, ProjectLegacyImportScope } from './projectLibraryStore';

export interface OrganizationWrite { readonly filePath: string; readonly text: string | undefined }
export interface ProjectOrganization {
    readonly root: string;
    groups: ProjectGroup[];
    legacyImports: ProjectLegacyImportScope[];
    readonly knownKeys: Set<string>;
    readonly historyKeys: Set<string>;
    readonly originalGroups: ReadonlyMap<string, ProjectGroup>;
    readonly originalImports: readonly ProjectLegacyImportScope[];
}
interface ReadOptions {
    readonly originals: Map<string, string | undefined>;
    readonly guard: (file: string) => Promise<void>;
    readonly parseGroup: (value: unknown) => ProjectGroup;
    readonly parseKey: (value: unknown) => string;
    readonly groupsOnly?: boolean;
}
const scopes: readonly ProjectLegacyImportScope[] = ['scenario', 'standalone'];
function document(text: string, allowed: readonly string[], file: string): Record<string, unknown> {
    const yaml = parseDocument(text, { uniqueKeys: true });
    let alias = false; visit(yaml, { Alias: () => { alias = true; } });
    const value = yaml.toJS() as Record<string, unknown> | null;
    if (alias || yaml.errors.length || yaml.warnings.length || !value || typeof value !== 'object' || Array.isArray(value)
        || value.version !== 1 || Object.keys(value).some(key => !allowed.includes(key))) {
        throw new Error(`Invalid project organization document: ${file}`);
    }
    return value;
}
function importScopes(value: unknown): ProjectLegacyImportScope[] {
    if (value === undefined) { return []; }
    if (!Array.isArray(value) || value.some(item => !scopes.includes(item)) || new Set(value).size !== value.length) {
        throw new Error('Unsupported legacy import marker');
    }
    return scopes.filter(scope => value.includes(scope));
}
export function projectGroupFile(root: string, id: string): string {
    let stem = encodeURIComponent(id).replace(/[A-Z!'()*]/gu, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(stem)) { stem = `%${stem.charCodeAt(0).toString(16).toUpperCase()}${stem.slice(1)}`; }
    return path.join(root, '.kot', 'groups', `${stem}.yml`);
}
export function projectHistoryFile(root: string, key: string): string {
    return path.join(root, '.kot', 'history', `${createHash('sha256').update(key).digest('hex')}.yml`);
}
function comparable(group: ProjectGroup): unknown {
    return { id: group.id, name: group.name, sections: group.sections };
}
function equal(left: unknown, right: unknown): boolean { return JSON.stringify(left) === JSON.stringify(right); }

/** Read-only; callers apply migration plans through the existing guarded transaction. */
export async function readProjectOrganization(root: string, options: ReadOptions): Promise<ProjectOrganization> {
    if (projectFormat(root).kind !== 'v3') { return { root, groups: [], legacyImports: [], knownKeys: new Set(), historyKeys: new Set(), originalGroups: new Map(), originalImports: [] }; }
    const read = async (file: string) => {
        await options.guard(file);
        const text = await fs.readFile(file, 'utf8').catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return undefined; } throw error;
        });
        options.originals.set(file, text); return text;
    };
    const list = async (directory: string): Promise<string[]> => {
        await options.guard(directory);
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(error => {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return []; } throw error;
        });
        for (const entry of entries) { if (entry.isSymbolicLink()) { throw new Error(`Project organization cannot follow symlinks: ${entry.name}`); } }
        return entries.filter(entry => entry.isFile() && entry.name.endsWith('.yml')).map(entry => path.join(directory, entry.name)).sort();
    };
    const groups = new Map<string, ProjectGroup>(); const originalGroups = new Map<string, ProjectGroup>();
    let legacyImports: ProjectLegacyImportScope[] = [];
    const historyKeys = new Set<string>();
    for (const file of await list(path.join(root, '.kot', 'groups'))) {
        const value = document((await read(file))!, ['version', 'id', 'name', 'sections'], file);
        const group = options.parseGroup({ id: value.id, name: value.name, sections: value.sections, order: 0 });
        if (projectGroupFile(root, group.id) !== file || originalGroups.has(group.id)) { throw new Error(`Duplicate or misplaced group ID: ${file}`); }
        groups.set(group.id, group); originalGroups.set(group.id, group);
    }
    const importsFile = path.join(root, '.kot', 'imports.yml');
    const importsText = options.groupsOnly ? undefined : await read(importsFile);
    const originalImports = importsText === undefined ? [] : importScopes(document(importsText, ['version', 'legacyImports'], importsFile).legacyImports);
    legacyImports = [...originalImports];
    if (!options.groupsOnly) {
        for (const file of await list(path.join(root, '.kot', 'history'))) {
            const value = document((await read(file))!, ['version', 'key'], file);
            const key = options.parseKey(value.key);
            if (projectHistoryFile(root, key) !== file || historyKeys.has(key)) { throw new Error(`Duplicate or misplaced scenario history key: ${file}`); }
            historyKeys.add(key);
        }
    }
    return { root, groups: [...groups.values()].map(group => ({ ...group, order: 0 })), legacyImports, knownKeys: new Set(historyKeys), historyKeys, originalGroups, originalImports };
}

/** Only changed group records are serialized; comments on unrelated records stay untouched. */
export function planProjectOrganizationWrites(organization: ProjectOrganization, groups: readonly ProjectGroup[],
    legacyImports: readonly ProjectLegacyImportScope[]): OrganizationWrite[] {
    const writes: OrganizationWrite[] = [];
    for (const group of groups) {
        if (!equal(comparable(group), organization.originalGroups.has(group.id) ? comparable(organization.originalGroups.get(group.id)!) : undefined)) {
            writes.push({ filePath: projectGroupFile(organization.root, group.id), text: stringify({ version: 1, ...comparable(group) as object }) });
        }
    }
    for (const id of organization.originalGroups.keys()) {
        if (!groups.some(group => group.id === id)) { writes.push({ filePath: projectGroupFile(organization.root, id), text: undefined }); }
    }
    if (!equal(legacyImports, organization.originalImports)) {
        writes.push({ filePath: path.join(organization.root, '.kot', 'imports.yml'), text: stringify({ version: 1, legacyImports }) });
    }
    return writes;
}
export function projectDeletionHistoryWrite(organization: ProjectOrganization, key: string): OrganizationWrite[] {
    if (organization.historyKeys.has(key)) { return []; }
    return [{ filePath: projectHistoryFile(organization.root, key), text: stringify({ version: 1, key }) }];
}
