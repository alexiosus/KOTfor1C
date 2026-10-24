import { isProjectSetupPending } from './projectSetupGate';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ProjectLibraryStore, projectEntityKey, type ProjectEntityIdentity, type ProjectEntityMetadata, type ProjectEntityMetadataPatch, type ProjectGroup, type ProjectLibrarySnapshot } from './projectLibraryStore';
import type { TestInfo } from './types';
import { projectGroupDisplayKey, type ProjectDisplayGroup } from './projectGroupDisplayOrder';

const snapshots = new Map<string, ProjectLibrarySnapshot>();

export function cacheProjectLibrarySnapshot(root: string, snapshot: ProjectLibrarySnapshot): void {
    snapshots.set(path.resolve(root), snapshot);
}

/** Reuse metadata already discovered by project views; never start discovery for a dropdown. */
export function getCachedProjectLibrarySnapshot(root: string): ProjectLibrarySnapshot | undefined {
    return snapshots.get(path.resolve(root));
}

/** Metadata watchers reuse the source catalog; source watchers remain responsible for discovery. */
export async function reloadProjectScenarioMetadata(infos: readonly TestInfo[], workspaceRoots: readonly string[], scanRoots: readonly string[], beforeWrite?: (root: string) => void): Promise<TestInfo[]> {
    const roots = new Map<string, ProjectEntityIdentity[]>();
    for (const info of infos) {
        const { root, identity } = location(info, workspaceRoots, scanRoots);
        const identities = roots.get(root) ?? [];
        identities.push(identity); roots.set(root, identities);
    }
    for (const [root, identities] of roots) {
        cacheProjectLibrarySnapshot(root, await createProjectLibraryStore(root, workspaceRoots, scanRoots, beforeWrite, identities).readMetadata());
    }
    return infos.map(info => applyCachedProjectScenarioMetadata(info, workspaceRoots, scanRoots));
}

export interface CreatedProjectScenarioMetadata {
    readonly main?: boolean;
    readonly groupName?: string;
    readonly order?: number;
    readonly category?: string;
}

function contains(root: string, file: string): boolean {
    const relative = path.relative(root, file);
    return relative === '' || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

const reportedWarnings = new Set<string>();
let sourceCleanupGuard: (filePath: string) => boolean = () => false;
export function setProjectSourceCleanupGuard(guard: (filePath: string) => boolean): void { sourceCleanupGuard = guard; }

export function createProjectLibraryStore(root: string, workspaceRoots: readonly string[], scanRoots: readonly string[], beforeWrite?: (root: string) => void,
    sourceIdentities?: readonly ProjectEntityIdentity[], sourceTexts?: ReadonlyMap<string, string>): ProjectLibraryStore {
    const owner = path.resolve(root);
    const discoveryRoots = [...new Set(scanRoots.map(value => path.resolve(value)))].filter(value =>
        contains(owner, value) && resolveProjectLibraryRoot(value, workspaceRoots, scanRoots) === owner);
    return new ProjectLibraryStore(owner, {
        discoveryRoots,
        excludedRoots: workspaceRoots.map(value => path.resolve(value)).filter(value => value !== owner && contains(owner, value)),
        sourceIdentities,
        sourceTexts,
        canCleanSource: filePath => sourceCleanupGuard(filePath),
        beforeWrite: () => beforeWrite?.(owner),
        onWarning: message => {
            const key = `${owner}:${message}`;
            if (!reportedWarnings.has(key)) { reportedWarnings.add(key); console.warn(`[ProjectLibrary] ${message}`); }
        }
    });
}

export function resolveProjectLibraryRoot(filePath: string, workspaceRoots: readonly string[], scanRoots: readonly string[]): string {
    for (const roots of [workspaceRoots, scanRoots]) {
        const root = roots.map(value => path.resolve(value)).filter(value => contains(value, path.resolve(filePath)))
            .sort((left, right) => right.length - left.length)[0];
        if (root) { return root; }
    }
    throw new Error('The source is outside the configured project and test roots.');
}

export function resolveProjectEntityIdentity(filePath: string, root: string, kind: ProjectEntityIdentity['kind'], uid?: string): ProjectEntityIdentity {
    if (!contains(path.resolve(root), path.resolve(filePath))) { throw new Error('Project metadata requires a source inside its project root.'); }
    return { kind, relativePath: path.relative(root, filePath).split(path.sep).join('/'), ...(uid?.trim() ? { uid: uid.trim() } : {}) };
}

function location(info: TestInfo, workspaceRoots: readonly string[], scanRoots: readonly string[], beforeWrite?: (root: string) => void) {
    const root = resolveProjectLibraryRoot(info.yamlFileUri.fsPath, workspaceRoots, scanRoots);
    const identity = resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid);
    return { root, identity, store: createProjectLibraryStore(root, workspaceRoots, scanRoots, beforeWrite, [identity]) };
}

function project(info: TestInfo, snapshot: ProjectLibrarySnapshot, identity: ProjectEntityIdentity): TestInfo {
    const metadata = snapshot.metadata[projectEntityKey(identity)];
    const main = info.kind === 'process' || info.hasTestSettings || !!info.tabName || (metadata && Object.hasOwn(metadata, 'groupId'));
    if (!main && !metadata && !snapshot.legacyImports.includes('scenario')) { return info; }
    const group = metadata?.groupId ? snapshot.groups.find(value => value.id === metadata.groupId) : undefined;
    return { ...info, ...(main ? { tabName: group?.name ?? 'Ungrouped', order: metadata?.order ?? Infinity } : {}),
        scenarioDescription: metadata?.description ?? '', scenarioCategory: metadata?.category ?? '' };
}

export function applyCachedProjectScenarioMetadata(info: TestInfo, workspaceRoots: readonly string[], scanRoots: readonly string[]): TestInfo {
    try {
        const { root, identity } = location(info, workspaceRoots, scanRoots);
        const snapshot = snapshots.get(root);
        return snapshot ? project(info, snapshot, identity) : info;
    } catch { return info; }
}

export function hasCachedProjectScenarioMetadata(info: TestInfo, workspaceRoots: readonly string[], scanRoots: readonly string[]): boolean {
    try {
        const { root, identity } = location(info, workspaceRoots, scanRoots);
        const snapshot = snapshots.get(root);
        return !!snapshot && (snapshot.legacyImports.includes('scenario') || !!snapshot.metadata[projectEntityKey(identity)]);
    }
    catch { return false; }
}

export async function loadProjectScenarioMetadata(infos: readonly TestInfo[], workspaceRoots: readonly string[], scanRoots: readonly string[], importLegacy = true,
    beforeWrite?: (root: string) => void, sourceTexts?: ReadonlyMap<string, string>): Promise<TestInfo[]> {
    const byRoot = new Map<string, TestInfo[]>();
    for (const info of infos) {
        const { root } = location(info, workspaceRoots, scanRoots);
        const items = byRoot.get(root) ?? [];
        items.push(info); byRoot.set(root, items);
    }
    for (const [root, items] of byRoot) {
        const sources = new Map<string, string>();
        for (const info of items) {
            const identity = resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid);
            const key = projectEntityKey(identity);
            const previous = sources.get(key);
            if (previous && previous !== info.yamlFileUri.fsPath) {
                throw new Error(`Duplicate scenario/process UID: ${previous}; ${info.yamlFileUri.fsPath}. Assign unique UIDs before importing project metadata.`);
            }
            sources.set(key, info.yamlFileUri.fsPath);
        }
    }
    for (const [root, items] of byRoot) {
        const store = createProjectLibraryStore(root, workspaceRoots, scanRoots, beforeWrite,
            items.map(info => resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid)), sourceTexts);
        let snapshot = !importLegacy ? await store.readMetadata() : sourceTexts ? await store.readKnownSources() : await store.read();
        if (importLegacy && !isProjectSetupPending(root) && !snapshot.legacyImports.includes('scenario')) {
            beforeWrite?.(root);
            const groups = new Map<string, ProjectGroup>();
            const entities: Array<{ identity: ProjectEntityIdentity; metadata: ProjectEntityMetadata }> = [];
            for (const info of items) {
                const section = info.kind === 'process' ? 'process' : 'main';
                let group: ProjectGroup | undefined;
                if (info.tabName?.trim()) {
                    const name = info.tabName.trim();
                    group = groups.get(name) ?? snapshot.groups.find(value => value.name === name && value.sections.some(value => value !== 'standalone'));
                    if (!group) {
                        const hash = createHash('sha256').update(`scenario:${name}`).digest('hex');
                        group = { id: `${hash.slice(0, 8)}-${hash.slice(8, 12)}-4${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`, name, sections: [section], order: groups.size };
                    } else if (!group.sections.includes(section)) { group = { ...group, sections: [...group.sections, section] }; }
                    groups.set(name, group);
                }
                entities.push({ identity: resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid),
                    metadata: { ...(group ? { groupId: group.id } : info.kind === 'process' || info.hasTestSettings ? { groupId: '' } : {}), ...(Number.isFinite(info.order) ? { order: info.order } : {}),
                        ...(info.scenarioDescription !== undefined ? { description: info.scenarioDescription } : {}),
                        ...(info.scenarioCategory !== undefined ? { category: info.scenarioCategory } : {}) } });
            }
            snapshot = await store.importLegacy({ groups: [...groups.values()], entities }, 'scenario');
        } else if (importLegacy && !isProjectSetupPending(root) && snapshot.knownScenarioKeys !== undefined) {
            const seeds: Parameters<ProjectLibraryStore['seedLegacyEntities']>[0][number][] = [];
            const known = new Set(snapshot.knownScenarioKeys);
            for (const info of items) {
                const identity = resolveProjectEntityIdentity(info.yamlFileUri.fsPath, root, info.kind === 'process' ? 'process' : 'scenario', info.uid);
                const key = projectEntityKey(identity);
                if (snapshot.metadata[key] || known.has(key)) { continue; }
                seeds.push({ identity, metadata: {
                    ...(info.kind === 'process' || info.hasTestSettings ? { groupId: '' } : {}),
                    ...(Number.isFinite(info.order) ? { order: info.order } : {}),
                    description: info.scenarioDescription ?? '', category: info.scenarioCategory ?? ''
                }, groupSeed: info.tabName ? { name: info.tabName, section: info.kind === 'process' ? 'process' : 'main' } : undefined });
            }
            if (seeds.length) { beforeWrite?.(root); snapshot = await store.seedLegacyEntities(seeds); }
        }
        snapshots.set(root, snapshot);
    }
    return infos.map(info => { const { root, identity } = location(info, workspaceRoots, scanRoots); return isProjectSetupPending(root) && !snapshots.get(root)?.metadata[projectEntityKey(identity)] ? info : project(info, snapshots.get(root)!, identity); });
}

export async function renameProjectLibraryGroup(groupId: string, expectedName: string, name: string, roots: readonly string[], beforeWrite: (root: string) => void, scanRoots: readonly string[] = roots): Promise<void> {
    const targets: ProjectLibraryStore[] = [];
    for (const root of roots) {
        const store = createProjectLibraryStore(root, roots, scanRoots, beforeWrite);
        const snapshot = await store.read();
        const group = snapshot.groups.find(value => value.id === groupId);
        if (!group || group.name !== expectedName) { throw new Error('The group changed. Refresh the panel and try again.'); }
        beforeWrite(root);
        if (snapshot.groups.some(value => value.id !== groupId && value.name === name && value.sections.some(section => group.sections.includes(section)))) {
            throw new Error('A group with this name already exists.');
        }
        targets.push(store);
    }
    for (const store of targets) { await store.renameGroup(groupId, name); }
}

export async function writeProjectScenarioMetadata(info: TestInfo, patch: ProjectEntityMetadataPatch, workspaceRoots: readonly string[], scanRoots: readonly string[], beforeWrite?: (root: string) => void): Promise<void> {
    const { root, identity, store } = location(info, workspaceRoots, scanRoots, beforeWrite);
    await store.setMetadata(identity, patch);
    snapshots.set(root, await store.read());
}

export async function registerProjectScenarioMetadata(info: TestInfo, workspaceRoots: readonly string[], scanRoots: readonly string[], beforeWrite?: (root: string) => void, createdMetadata?: CreatedProjectScenarioMetadata): Promise<void> {
    const { store } = location(info, workspaceRoots, scanRoots, beforeWrite);
    const groupName = (createdMetadata?.groupName ?? info.tabName)?.trim();
    const group = groupName ? await store.ensureGroup(groupName, info.kind === 'process' ? 'process' : 'main') : undefined;
    const main = createdMetadata?.main || info.kind === 'process' || !!info.tabName;
    const order = createdMetadata?.order ?? info.order;
    await writeProjectScenarioMetadata(info, { ...(group ? { groupId: group.id } : main ? { groupId: '' } : {}),
        ...(Number.isFinite(order) ? { order } : {}), description: info.scenarioDescription ?? '',
        category: createdMetadata?.category ?? info.scenarioCategory ?? '' }, workspaceRoots, scanRoots, beforeWrite);
}

export async function remapProjectScenarioMetadata(previous: TestInfo, next: TestInfo, workspaceRoots: readonly string[], scanRoots: readonly string[], beforeWrite?: (root: string) => void): Promise<void> {
    const old = location(previous, workspaceRoots, scanRoots, beforeWrite);
    const target = location(next, workspaceRoots, scanRoots, beforeWrite);
    if (old.root === target.root) {
        const store = createProjectLibraryStore(old.root, workspaceRoots, scanRoots, beforeWrite, [old.identity, target.identity]);
        await store.remapEntity(old.identity, target.identity);
        snapshots.set(old.root, await store.read());
        return;
    }
    const oldSnapshot = await old.store.read();
    const targetSnapshot = await target.store.read();
    const oldMetadata = oldSnapshot.metadata[projectEntityKey(old.identity)];
    const targetMetadata = targetSnapshot.metadata[projectEntityKey(target.identity)];
    if (oldMetadata && targetMetadata) {
        throw new Error(`Project metadata conflict: the destination already has metadata for ${target.identity.relativePath}. Resolve both records before moving them.`);
    }
    const metadata = oldMetadata ?? targetMetadata;
    if (!metadata) { return; }
    beforeWrite?.(old.root); beforeWrite?.(target.root);
    const oldGroup = oldSnapshot.groups.find(group => group.id === metadata.groupId);
    const group = oldGroup ? await target.store.ensureGroup(oldGroup.name, next.kind === 'process' ? 'process' : 'main', oldGroup.id) : undefined;
    await target.store.setMetadata(target.identity, { ...metadata, groupId: group?.id ?? '' });
    if (oldMetadata) { await old.store.deleteMetadata(old.identity); }
    snapshots.set(old.root, await old.store.read()); snapshots.set(target.root, await target.store.read());
}

export async function loadProjectLibraryGroups(workspaceRoots: readonly string[], scanRoots: readonly string[], beforeWrite?: (root: string) => void): Promise<ProjectGroup[]> {
    const owned = await loadProjectLibraryOwnedGroups(workspaceRoots, scanRoots, beforeWrite);
    const groups = new Map<string, ProjectGroup>();
    for (const group of owned) {
        const key = JSON.stringify([group.id, group.name]);
        const previous = groups.get(key);
        const shared: ProjectGroup = { id: group.id, name: group.name, sections: group.sections, order: group.order };
        groups.set(key, previous ? { ...shared, sections: [...new Set([...previous.sections, ...group.sections])],
            order: Math.min(previous.order, group.order) } : shared);
    }
    return [...groups.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

export async function loadProjectLibraryOwnedGroups(workspaceRoots: readonly string[], scanRoots: readonly string[], beforeWrite?: (root: string) => void): Promise<ProjectDisplayGroup[]> {
    const roots = new Set(workspaceRoots.map(root => path.resolve(root)));
    for (const root of scanRoots) { roots.add(resolveProjectLibraryRoot(root, workspaceRoots, scanRoots)); }
    const groups: ProjectDisplayGroup[] = [];
    for (const root of roots) {
        const snapshot = await createProjectLibraryStore(root, workspaceRoots, scanRoots, beforeWrite).readMetadata();
        for (const group of snapshot.groups) {
            groups.push({ ...group, projectRoot: root, key: projectGroupDisplayKey(root, group.id) });
        }
    }
    return groups.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}
