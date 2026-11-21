import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { AgentStore } from './agentStore';
import { AgentWorkspace, agentContains, agentHash, agentFileHash } from './agentWorkspace';
import type { AgentChange } from './agentRepair';
import { VANESSA_CLIENT_EXTENSION } from './vanessaControlProvisioning';
import { buildFileInfobaseConnectionArgument } from './oneCInfobaseConnection';
import type { RegisterLauncherInfobaseResult } from './infobasePicker';

export interface AgentInfobasePorts {
    execute(args: readonly string[], log: string, authenticate?: boolean): Promise<void>;
    register(infobase: string, name: string): Promise<RegisterLauncherInfobaseResult>;
    idle(): boolean;
    provenance(): Promise<unknown>;
}
export interface AgentEnvironmentRequest {
    readonly action: 'create' | 'register' | 'checkpoint' | 'update' | 'prepare_tools'; readonly sourceKind?: 'empty' | 'dt' | 'cf' | 'sources';
    readonly source?: string; readonly environmentId?: string; readonly requestKey: string;
    readonly stateRole?: 'initial' | 'failure' | 'checkpoint' | 'unspecified';
    readonly languageName?: string;
    readonly name?: string;
    readonly repairId?: string;
}
export interface AgentConfigurationDeployment {
    readonly operationId: string; readonly repairId: string;
    readonly files: readonly { readonly path: string; readonly sha256: string }[];
}

/** The pinned extension borrows one language; configurations can give ru a different technical name. */
export async function adaptVanessaClientLanguage(directory: string, name: string): Promise<void> {
    if (!/^[\p{L}_][\p{L}\p{N}_]{0,79}$/u.test(name)) { throw new Error('Choose a valid configuration language identifier.'); }
    if (name === 'Русский') { return; }
    const configuration = path.join(directory, 'Configuration.xml');
    const language = path.join(directory, 'Languages', 'Русский.xml');
    const target = path.join(directory, 'Languages', name + '.xml');
    const configText = await fs.readFile(configuration, 'utf8'); const languageText = await fs.readFile(language, 'utf8');
    if (configText.split('<Language>Русский</Language>').length !== 2 || languageText.split('<Name>Русский</Name>').length !== 2) {
        throw new Error('The pinned extension language metadata changed.');
    }
    await fs.writeFile(target, languageText.replace('<Name>Русский</Name>', '<Name>' + name + '</Name>'), { flag: 'wx' });
    await fs.unlink(language);
    await fs.writeFile(configuration, configText.replace('<Language>Русский</Language>', '<Language>' + name + '</Language>'));
    const dump = path.join(directory, 'ConfigDumpInfo.xml');
    await fs.writeFile(dump, (await fs.readFile(dump, 'utf8')).replaceAll('Language.Русский', 'Language.' + name));
}
export class AgentInfobases {
    private active = false;
    private pending = new Set<Promise<void>>();
    constructor(private readonly store: AgentStore, private readonly workspace: AgentWorkspace, private readonly ports: AgentInfobasePorts) {}
    async configurationDeployment(environmentId: string): Promise<AgentConfigurationDeployment | undefined> {
        const environment = await this.store.get(environmentId);
        const updated = [...environment.events].reverse().find(event => event.kind === 'configuration_updated')?.data as { operationId?: string } | undefined;
        const record = updated?.operationId ? await this.store.get(updated.operationId) : environment;
        if (record.status !== 'completed') { return undefined; }
        return (record.result as { configurationDeployment?: AgentConfigurationDeployment } | undefined)?.configurationDeployment;
    }
    private async sourceDeployment(id: string, request: AgentEnvironmentRequest, source?: string): Promise<AgentConfigurationDeployment | undefined> {
        if (!request.repairId) { return undefined; }
        if (request.sourceKind !== 'sources' || !source) { throw new Error('Bind a configuration repair to its source directory.'); }
        const repair = await this.store.get(request.repairId);
        if (repair.kind !== 'repair' || repair.status !== 'completed' || !(repair.request.risks as string[] | undefined)?.includes('configuration')) {
            throw new Error('Select an applied configuration repair.');
        }
        const changes = (repair.request.changes as AgentChange[]).filter(change => agentContains(source, change.path));
        if (!changes.length) { throw new Error('The repaired configuration sources are outside this installation directory.'); }
        const deployment = { operationId: id, repairId: repair.id, files: changes.map(change => ({ path: change.path, sha256: agentHash(change.text) })) };
        await this.assertDeploymentSources(deployment); return deployment;
    }
    private async assertDeploymentSources(deployment: AgentConfigurationDeployment): Promise<void> {
        for (const file of deployment.files) {
            if (await agentFileHash(await this.workspace.resolve(file.path)) !== file.sha256) { throw new Error('Configuration repair sources changed during installation.'); }
        }
    }
    async start(request: AgentEnvironmentRequest) {
        if (request.name !== undefined) {
            if (!['create', 'register'].includes(request.action) || !request.name.trim() || request.name.length > 200 || /[\u0000-\u001f\u007f\[\]]/u.test(request.name)) {
                throw new Error('Choose a non-empty launcher name up to 200 characters without control characters or brackets for create/register.');
            }
            request = { ...request, name: request.name.trim() };
        }
        if (request.action !== 'create' && !request.environmentId) { throw new Error('Select an agent-owned environment.'); }
        const created = await this.store.create('environment', { ...request }, request.requestKey);
        if (created.existing) { return created.record; }
        if (this.active || !this.ports.idle()) {
            await this.store.update(created.record.id, value => { value.status = 'cancelled'; value.result = { error: 'environment_busy' }; });
            throw new Error('Close the test client and wait for active operations before changing an infobase.');
        }
        this.active = true;
        const work = this.execute(created.record.id, request).finally(() => { this.active = false; this.pending.delete(work); });
        this.pending.add(work); void work.catch(() => undefined); return { ...created.record, status: 'running' as const };
    }
    async owned(id: string, operationId?: string): Promise<string> {
        const record = await this.store.get(id);
        if (record.kind !== 'environment' || record.request.action !== 'create' || record.status !== 'completed') { throw new Error('This environment is not ready.'); }
        const updates = (await this.store.list(100_000)).filter(operation => operation.id !== operationId && operation.kind === 'environment'
            && ['update', 'prepare_tools'].includes(String(operation.request.action)) && operation.request.environmentId === id && !['completed', 'cancelled'].includes(operation.status));
        for (const operation of updates) {
            if ((await this.store.get(operation.id)).events.some(event => event.kind === 'configuration_preflight_rejected')) { continue; }
            if (operation.request.action === 'prepare_tools' && ['failed', 'unknown'].includes(operation.status) &&
                !(await this.store.get(operation.id)).events.some(event => event.kind === 'tools_install_started')) { continue; }
            throw new Error('This environment has an incomplete configuration update. Restore a fresh copy before verification.');
        }
        const file = path.join(this.store.directory, id, 'infobase');
        const actual = await fs.realpath(file);
        const canonicalRoot = await fs.realpath(this.store.directory);
        const expected = path.join(await fs.realpath(path.dirname(file)), 'infobase');
        if (!agentContains(canonicalRoot, actual) || !agentContains(expected, actual) || !agentContains(actual, expected)) { throw new Error('Environment path changed.'); }
        return actual;
    }
    private async register(id: string, infobase: string, environmentId = id, name?: string) {
        let launcher: RegisterLauncherInfobaseResult | { status: 'failed'; error: string };
        try {
            launcher = await this.ports.register(infobase, name ?? `KOT Agent ${path.basename(this.workspace.root)} ${environmentId.slice(0, 8)}`);
        } catch (error) {
            launcher = { status: 'failed', error: error instanceof Error ? error.message : 'Launcher registration failed.' };
        }
        await this.store.event(id, 'launcher_registration', launcher);
        return launcher;
    }
    private async execute(id: string, request: AgentEnvironmentRequest) {
        const log = path.join(this.store.directory, id, '1c.log');
        let configurationStarted = false;
        try {
            await this.store.update(id, value => { value.status = 'running'; });
            const directory = path.join(this.store.directory, id);
            await this.store.artifact(id, 'environment-provenance.json', JSON.stringify(await this.ports.provenance(), null, 2));
            const source = request.source ? await this.workspace.resolve(request.source) : undefined;
            const deployment = ['create', 'update'].includes(request.action) ? await this.sourceDeployment(id, request, source) : undefined;
            let infobase: string;
            if (request.action === 'create') {
                const kind = request.sourceKind ?? 'empty';
                if (kind !== 'empty' && !source) { throw new Error('Select a DT, CF or configuration source directory.'); }
                if (kind === 'dt' && !/\.dt$/iu.test(source!) || kind === 'cf' && !/\.cf$/iu.test(source!)) { throw new Error('The source does not match the selected format.'); }
                const sourceSha256 = source && ['dt', 'cf'].includes(kind) ? await agentFileHash(source) : undefined;
                const checkpoint = kind === 'dt' ? (await this.store.list(100_000)).find(record => {
                    const dump = (record.result as { dt?: string } | undefined)?.dt;
                    return record.kind === 'environment' && record.status === 'completed' && record.request.action === 'checkpoint'
                        && dump && path.relative(dump, source!) === '';
                }) : undefined;
                const inherited = checkpoint?.result as { sha256?: string; configurationDeployment?: AgentConfigurationDeployment } | undefined;
                if (inherited?.sha256 && inherited.sha256 !== sourceSha256) { throw new Error('The owned checkpoint checksum changed.'); }
                infobase = path.join(directory, 'infobase'); await fs.mkdir(infobase);
                await this.ports.execute(['CREATEINFOBASE', buildFileInfobaseConnectionArgument(infobase, { trailingSemicolon: true }), '/DisableStartupDialogs', '/DisableStartupMessages'], log, false);
                if (kind !== 'empty') {
                    const operation = kind === 'dt' ? ['/RestoreIB', source!] : kind === 'cf' ? ['/LoadCfg', source!, '/UpdateDBCfg'] : ['/LoadConfigFromFiles', source!, '/UpdateDBCfg'];
                    await this.ports.execute(['DESIGNER', '/F', infobase, '/DisableStartupDialogs', '/DisableStartupMessages', ...operation], log, false);
                }
                if (deployment) { await this.assertDeploymentSources(deployment); }
                if (sourceSha256 && await agentFileHash(source!) !== sourceSha256) { throw new Error('The database source changed during restoration.'); }
                const launcher = await this.register(id, infobase, id, request.name);
                await this.store.update(id, value => { value.status = 'completed'; value.result = { infobase, sourceKind: kind, source,
                    launcher,
                    sourceSha256, configurationDeployment: deployment ?? (inherited?.sha256 ? inherited.configurationDeployment : undefined),
                    stateRole: request.stateRole ?? (kind === 'dt' ? 'unspecified' : 'initial'), state: 'saved_database', sessionRestored: false }; });
            } else {
                infobase = await this.owned(request.environmentId!, id);
                if (request.action === 'register') {
                    const environment = await this.store.get(request.environmentId!);
                    const launcher = await this.register(id, infobase, request.environmentId, request.name ?? environment.request.name as string | undefined);
                    await this.store.update(request.environmentId!, value => { value.result = { ...value.result as object, launcher }; });
                    await this.store.update(id, value => { value.status = launcher.status === 'failed' ? 'failed' : 'completed';
                        value.result = { infobase, environmentId: request.environmentId, launcher }; });
                } else if (request.action === 'checkpoint') {
                    const dump = path.join(directory, 'checkpoint.dt');
                    await this.ports.execute(['DESIGNER', '/F', infobase, '/DisableStartupDialogs', '/DisableStartupMessages', '/DumpIB', dump], log);
                    const stat = await fs.stat(dump);
                    if (!stat.isFile() || !stat.size) { throw new Error('1C did not create a checkpoint.'); }
                    const canonicalDump = await fs.realpath(dump);
                    const sha256 = await agentFileHash(dump); const configurationDeployment = await this.configurationDeployment(request.environmentId!);
                    await this.store.update(id, value => { value.status = 'completed'; value.result = { sourceEnvironment: request.environmentId,
                        dt: canonicalDump, bytes: stat.size, sha256, configurationDeployment, capturedAt: new Date().toISOString(), sessionRestored: false, prerequisites: 'Reconstruct UI and Vanessa context before a partial replay.' }; });
                } else if (request.action === 'prepare_tools') {
                    const stat = source ? await fs.stat(source) : undefined;
                    if (!source || !/\.cfe$/iu.test(source) || !stat?.isFile() || stat.size > 1024 * 1024 ||
                        agentHash(await fs.readFile(source)) !== VANESSA_CLIENT_EXTENSION.sha256) {
                        throw new Error('Select the official VAExtension 1.43 CFE matching the pinned release SHA-256: ' + VANESSA_CLIENT_EXTENSION.url);
                    }
                    if (request.languageName && !/^[\p{L}_][\p{L}\p{N}_]{0,79}$/u.test(request.languageName)) { throw new Error('Choose a valid configuration language identifier.'); }
                    await this.store.event(id, 'tools_install_started', { environmentId: request.environmentId, component: VANESSA_CLIENT_EXTENSION });
                    await this.ports.execute(['DESIGNER', '/F', infobase, '/DisableStartupDialogs', '/DisableStartupMessages',
                        '/LoadCfg', source, '-Extension', VANESSA_CLIENT_EXTENSION.name,
                        ...(!request.languageName || request.languageName === 'Русский' ? ['/UpdateDBCfg'] : [])], log);
                    if (request.languageName && request.languageName !== 'Русский') {
                        const exported = path.join(directory, 'tool-source'); await fs.mkdir(exported);
                        await this.ports.execute(['DESIGNER', '/F', infobase, '/DisableStartupDialogs', '/DisableStartupMessages',
                            '/DumpConfigToFiles', exported, '-Extension', VANESSA_CLIENT_EXTENSION.name], log);
                        await adaptVanessaClientLanguage(exported, request.languageName);
                        await this.store.artifact(id, 'tool-language-adaptation.json', JSON.stringify({ component: VANESSA_CLIENT_EXTENSION, borrowedLanguage: request.languageName,
                            configuration: agentHash(await fs.readFile(path.join(exported, 'Configuration.xml'))), language: agentHash(await fs.readFile(path.join(exported, 'Languages', request.languageName + '.xml'))) }, null, 2));
                        await this.ports.execute(['DESIGNER', '/F', infobase, '/DisableStartupDialogs', '/DisableStartupMessages',
                            '/LoadConfigFromFiles', exported, '-Extension', VANESSA_CLIENT_EXTENSION.name, '/UpdateDBCfg'], log);
                    }
                    await this.store.event(request.environmentId!, 'tools_prepared', { operationId: id, component: VANESSA_CLIENT_EXTENSION });
                    await this.store.update(id, value => { value.status = 'completed'; value.result = { infobase, source, component: VANESSA_CLIENT_EXTENSION, borrowedLanguage: request.languageName ?? 'Русский',
                        next: 'Restart the test client and verify the advertised data tool. Installation alone does not confirm database access.' }; });
                } else {
                    if (!source || !['cf', 'sources'].includes(request.sourceKind ?? '')) { throw new Error('Choose CF or configuration sources for an update.'); }
                    const operation = request.sourceKind === 'cf' ? ['/LoadCfg', source, '/UpdateDBCfg'] : ['/LoadConfigFromFiles', source, '/UpdateDBCfg'];
                    await this.store.event(id, 'configuration_install_started', { environmentId: request.environmentId }); configurationStarted = true;
                    await this.ports.execute(['DESIGNER', '/F', infobase, '/DisableStartupDialogs', '/DisableStartupMessages', ...operation], log);
                    if (deployment) { await this.assertDeploymentSources(deployment); }
                    await this.store.event(request.environmentId!, 'configuration_updated', { operationId: id, source, previousCheckpointsRequireReview: true });
                    await this.store.update(id, value => { value.status = 'completed'; value.result = { infobase, source, updated: true, configurationDeployment: deployment }; });
                }
            }
        } catch (error) {
            if (request.action === 'update' && !configurationStarted) { await this.store.event(id, 'configuration_preflight_rejected', {}); }
            await this.store.update(id, value => { value.status = error instanceof Error && error.message.includes('timed out') ? 'unknown' : 'failed';
                value.result = { error: error instanceof Error ? error.message : 'Environment preparation failed' }; });
        } finally {
            try { await this.store.artifact(id, '1c-output.log', await fs.readFile(log, 'utf8')); } catch { /* An empty command may not create a log. */ }
        }
    }
    get busy(): boolean { return this.active; }
    async idle(): Promise<void> { await Promise.all(this.pending); }
}
