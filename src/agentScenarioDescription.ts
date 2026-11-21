import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { AgentWorkspace, agentHash } from './agentWorkspace';
import { projectFormat, assertProjectFormatUnchanged } from './projectFormat';
import { ProjectLibraryStore, projectEntityKey } from './projectLibraryStore';
import { resolveProjectEntityIdentity, resolveProjectLibraryRoot } from './projectLibraryMetadata';
import { readLegacyMetadata, editLegacyMetadata } from './projectLegacyMetadata';
import { ScenarioYamlDocument } from './scenarioYamlDocument';
import { parseScenarioDescriptor } from './scenarioDescriptor';
import { readFeatureProperties, planFeaturePropertiesEdit } from './featurePropertiesModel';

export interface AgentDescriptionUpdate { description: string; expectedRevision: string }
export interface AgentScenarioDescription {
    path: string; name?: string; description: string; revision: string;
    storage: 'sidecar' | 'feature' | 'inline'; sources: Array<{ path: string; sha256: string }>; saved?: boolean;
}
export interface AgentDescriptionPorts {
    workspaceRoots: readonly string[];
    scanRoots: readonly string[];
    assertEditable(files: readonly string[], root: string): void;
    replace(file: string, before: string, after: string): Promise<void>;
    changed(files: readonly string[]): Promise<void>;
}

/** The agent supplies prose; existing property editors and metadata stores own its format. */
export async function agentScenarioDescription(workspace: AgentWorkspace, ports: AgentDescriptionPorts,
    action: 'read' | 'set', source: string, update?: AgentDescriptionUpdate): Promise<AgentScenarioDescription> {
    let file = await workspace.resolve(source);
    if (path.basename(file) === 'scen.feature') {
        const metadata = path.join(path.dirname(file), 'meta.yaml');
        try {
            const text = await fs.readFile(await workspace.resolve(metadata), 'utf8');
            if (/^\uFEFF?ТипФайла:[ \t]*["']?Сценарий["']?[ \t]*\r?$/mu.test(text)) { file = await workspace.resolve(metadata); }
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
    }
    if (!/\.(?:yaml|yml|feature)$/iu.test(file) || file.endsWith('.kot.yml')) { throw new Error('Choose a scenario source, not its metadata sidecar.'); }
    const root = resolveProjectLibraryRoot(file, ports.workspaceRoots, ports.scanRoots);
    const format = projectFormat(root);
    if (format.kind === 'invalid') { throw new Error(format.error); }
    const files = new Map<string, string>();
    const read = async (target: string) => {
        const resolved = await workspace.resolve(target);
        if ((await fs.stat(resolved)).size > 4 * 1024 * 1024) { throw new Error('Scenario source exceeds 4 MiB.'); }
        const text = await fs.readFile(resolved, 'utf8');
        if (text.includes('\0')) { throw new Error('A scenario must be text.'); }
        files.set(resolved, text); return text;
    };
    const text = await read(file);
    if (path.basename(file) === 'meta.yaml') { await read(path.join(path.dirname(file), 'scen.feature')); }
    const feature = /\.feature$/iu.test(file);
    const document = { uri: file, text, version: 0 };
    if (!feature) { ScenarioYamlDocument.parse(text).requireValidForEdit(); }
    const descriptor = feature ? undefined : parseScenarioDescriptor(text);
    if (!feature && !ScenarioYamlDocument.parse(text).findSection(descriptor?.kind === 'process' ? 'ДанныеПроцесса' : 'ДанныеСценария')) {
        throw new Error('The selected YAML is not a scenario or process.');
    }
    const model = feature ? readFeatureProperties(document) : undefined;
    const legacy = feature ? undefined : readLegacyMetadata(text);
    const identity = feature ? undefined : resolveProjectEntityIdentity(file, root, descriptor?.kind === 'process' ? 'process' : 'scenario', descriptor?.uid);
    const guard = () => {
        assertProjectFormatUnchanged(root, format);
        ports.assertEditable([...files.keys()], root);
        for (const [target, before] of files) {
            if (readFileSync(target, 'utf8') !== before) { throw new Error('Scenario source changed. Read its description again.'); }
        }
    };
    const store = !feature && format.kind === 'v3' ? new ProjectLibraryStore(root, {
        sourceIdentities: [identity!], canCleanSource: () => false,
        beforeWrite: paths => { guard(); ports.assertEditable(paths, root); }
    }) : undefined;
    const snapshot = await store?.readMetadata();
    const metadata = snapshot?.metadata[projectEntityKey(identity!)];
    const fallback = snapshot?.legacyImports.includes('scenario') ? '' : legacy?.values.description ?? '';
    const description = model?.description ?? (metadata ? metadata.description ?? '' : fallback);
    const revision = agentHash(JSON.stringify({ file, format, description, files: [...files].map(([target, value]) => [target, agentHash(value)]) }));
    const result: AgentScenarioDescription = { path: file, name: model?.title ?? descriptor?.name, description, revision,
        storage: store ? 'sidecar' : feature ? 'feature' : 'inline',
        sources: [...files].map(([target, value]) => ({ path: target, sha256: agentHash(value) })) };
    assertProjectFormatUnchanged(root, format);
    if (action === 'read') { return result; }
    if (!update || update.expectedRevision !== revision) { throw new Error('Scenario or description changed. Read its description again.'); }
    if (feature && /^\s*(?:#|\/\/)/mu.test(update.description)) { throw new Error('Use plain text without comment lines for a standalone feature description.'); }
    guard();
    if (!store && update.description === description) { return { ...result, saved: true }; }
    if (store) {
        if (!metadata && !snapshot!.legacyImports.includes('scenario')) {
            const { groupId: _groupId, ...values } = legacy!.values;
            await store.seedLegacyEntity(identity!, values, legacy!.group ? { name: legacy!.group.name, section: descriptor?.kind === 'process' ? 'process' : 'main' } : undefined);
        }
        await store.setMetadata(identity!, { description: update.description }, current => {
            guard();
            if ((current ? current.description ?? '' : fallback) !== description) { throw new Error('Description changed. Read it again.'); }
        });
    } else {
        const edit = feature ? planFeaturePropertiesEdit(document, { uri: file, version: 0, field: 'description', value: update.description }) : undefined;
        const after = edit ? text.slice(0, edit.start) + edit.text + text.slice(edit.end) : editLegacyMetadata(text, { description: update.description }, []);
        guard();
        if (after !== text) { await ports.replace(file, text, after); }
    }
    await ports.changed([file]);
    return { ...await agentScenarioDescription(workspace, ports, 'read', file), saved: true };
}
