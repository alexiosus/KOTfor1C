import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import * as net from 'node:net';
import { AgentService } from './agentService';
import { acquireVanessaControl } from './vanessaControlLease';
import { agentClientTemplate, agentLaunchLocale, agentProjectDirectory, prepareAgentProjectDirectory, type AgentClientTemplate } from './agentClient';
import { YamlParametersManager } from './yamlParametersManager';
import { AgentStore } from './agentStore';
import { AgentWorkspace, agentHash, agentContains } from './agentWorkspace';
import { AgentMcpServer } from './agentMcpServer';
import type { AgentTest } from './agentExecution';
import type { PhaseSwitcherProvider } from './phaseSwitcher';
import type { ProjectDefinitionResolver } from './projectDefinitionResolver';
import type { StandaloneFeatureService } from './standaloneFeatureService';
import type { VanessaControlSession } from './vanessaControlSession';
import { getScenarioScanRootPath } from './scenarioScanRoot';
import { resolveVanessaStepLine } from './vanessaControlFeature';
import { getFormExplorerConfigurationSourceDirectory } from './formExplorerPaths';
import { registerInfobaseInLauncher } from './infobasePicker';
import { getScenarioRuntimeKey } from './scenarioRuntimeIdentity';
import { VanessaDebugClientStore, type VanessaDebugClient } from './vanessaDebugClients';
import { normalizeInfobaseConnectionIdentity } from './oneCInfobaseConnection';
import { matchesVanessaClientSettings } from './vanessaControlClients';
import { redactVanessaDiagnosticText } from './vanessaControlRedaction';
import { collectGherkinSyntaxErrors } from './gherkinSyntaxValidator';
import { resolveSharedStartupPlatform } from './sharedStartupPlatform';
import { mapYamlLineToFeatures, mapFeatureLineToYaml } from './vanessaControlSourceMapping';
import { mapAgentNativeLine, mapAgentNativeFailure, type AgentNativeSource } from './agentNativeSources';
import { configureAgentClient, checkAgentSetup } from './agentSetup';
import { agentScenarioDescription } from './agentScenarioDescription';
import { projectLibraryEnvironment, assertProjectMetadataSaved } from './projectLibraryIntegration';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';

export interface AgentExtensionDependencies {
    readonly actions?: (workspace: AgentWorkspace) => import('./agentActions').AgentActionPorts;
    readonly provider: PhaseSwitcherProvider;
    readonly definitions: ProjectDefinitionResolver;
    readonly standalone: StandaloneFeatureService;
    readonly session: VanessaControlSession;
    readonly ensureConnected: () => Promise<boolean>;
    readonly manager: (action: 'list' | 'connect' | 'start', endpoint?: string) => Promise<unknown>;
    readonly runLog: () => string | undefined;
}

export function registerAgentExtension(context: vscode.ExtensionContext, dependencies: AgentExtensionDependencies): void {
    const { provider, definitions, standalone, session } = dependencies;
    let service: AgentService | undefined; let server: AgentMcpServer | undefined; let starting: Promise<AgentService> | undefined;
    let stopping: Promise<void> | undefined;
    let connectionFile: string | undefined; let selection: string[] | undefined;
    let agentRunning = false; let agentBuilding = false; let agentSetupRunning = false;
    let disposed = false;
    const status = vscode.window.createStatusBarItem('kotTestToolkit.agentServer', vscode.StatusBarAlignment.Left, 18);
    status.name = vscode.l10n.t('KOT agent MCP server');
    context.subscriptions.push(status);
    const statusLabels = {
        stopped: vscode.l10n.t('KOT Agent: stopped'), starting: vscode.l10n.t('KOT Agent: starting…'),
        running: vscode.l10n.t('KOT Agent: running'), stopping: vscode.l10n.t('KOT Agent: stopping…'), error: vscode.l10n.t('KOT Agent: error')
    };
    const showStatus = (state: keyof typeof statusLabels, url = '') => {
        if (disposed) { return; }
        const busy = state === 'starting' || state === 'stopping';
        status.text = `${busy ? '$(loading~spin)' : state === 'running' ? '$(broadcast)' : state === 'error' ? '$(error)' : '$(circle-slash)'} ${statusLabels[state]}`;
        status.command = busy ? undefined : state === 'running' ? 'kotTestToolkit.agent.stop' : 'kotTestToolkit.agent.start';
        status.backgroundColor = state === 'error' ? new vscode.ThemeColor('statusBarItem.errorBackground') : undefined;
        status.tooltip = state === 'running' ? vscode.l10n.t('KOT agent MCP server is running at {0}. Click to stop.', url)
            : state === 'stopped' ? vscode.l10n.t('KOT agent MCP server is stopped. Click to start.')
                : state === 'error' ? vscode.l10n.t('KOT agent MCP server failed. Click to retry starting.') : statusLabels[state];
        status.accessibilityInformation = { label: statusLabels[state] };
        status.show();
    };
    showStatus('stopped');
    let nativeGuard: { sources: AgentNativeSource[]; manifestHash: string } | undefined;
    const selectedArchives = new Set<string>();
    const config = () => vscode.workspace.getConfiguration('kotTestToolkit.agent');
    const trusted = () => vscode.workspace.isTrusted !== false;
    const control = <T>(acquire: (entered: () => void) => Promise<T>) => acquireVanessaControl(acquire,
        () => !!session.snapshot.runActive || ['running', 'stopping'].includes(session.snapshot.status));
    const editable = (files: readonly string[]) => {
        if (vscode.workspace.textDocuments.some(document => document.isDirty && files.some(file => document.uri.fsPath === file))) { throw new Error('Save affected sources before an agent operation.'); }
    };
    const savedClient = async (): Promise<VanessaDebugClient | undefined> => {
        const clients = await new VanessaDebugClientStore(context.workspaceState, context.secrets).loadCatalog();
        const id = config().get<string>('clientProfileId', '');
        if (id && !clients.some(client => client.id === id)) { throw new Error('The configured agent client profile was not found.'); }
        return id ? clients.find(client => client.id === id) : undefined;
    };
    const tests = async (): Promise<AgentTest[]> => {
        const catalog = await provider.ensureFreshScenarioCatalog(); await standalone.ensureReady();
        return [...catalog.all.filter(test => test.hasTestSettings).map(test => ({ id: agentHash(test.yamlFileUri.toString()), name: test.name,
            source: test.yamlFileUri.fsPath, script: path.basename(test.yamlFileUri.fsPath) === 'meta.yaml' ? path.join(path.dirname(test.yamlFileUri.fsPath), 'scen.feature') : undefined,
            group: test.tabName, dependencies: test.nestedScenarioNames })),
        ...standalone.getSnapshot().features.map(test => ({ id: agentHash(test.uri), name: test.title, source: vscode.Uri.parse(test.uri).fsPath, group: test.groupId }))];
    };
    const stop = (): Promise<void> => {
        if (stopping) { return stopping; }
        showStatus('stopping');
        const oldServer = server; server = undefined;
        const oldService = service; service = undefined;
        stopping = (async () => {
            if (connectionFile) { await fs.unlink(connectionFile).catch(() => undefined); connectionFile = undefined; }
            try { await oldService?.dispose(); } finally { await oldServer?.close(); }
        })().then(() => { showStatus('stopped'); }, error => { showStatus('error'); throw error; }).finally(() => { stopping = undefined; });
        return stopping;
    };
    const start = (): Promise<AgentService> => {
        if (starting) { return starting; } if (stopping) { return stopping.then(start); } if (service) { return Promise.resolve(service); }
        showStatus('starting');
        starting = (async () => {
            if (disposed) { throw new Error('The extension is stopping.'); }
            if (!trusted()) { throw new Error('Trust this workspace before starting the agent server.'); }
            const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
            if (!root) { throw new Error('Open a project folder before starting the agent server.'); }
            const runtime = path.resolve(root, vscode.workspace.getConfiguration('kotTestToolkit').get<string>('runtime.directory', '.vscode/kot-runtime'));
            const directory = path.join(runtime, 'agent'); await fs.mkdir(directory, { recursive: true });
            const workspace: AgentWorkspace = new AgentWorkspace(root, () => [...config().get<string[]>('allowedRoots', []), ...selectedArchives, runtime,
                path.resolve(root, getScenarioScanRootPath()), ...(getFormExplorerConfigurationSourceDirectory() ? [getFormExplorerConfigurationSourceDirectory()!] : [])], async file => {
                if (disposed || !trusted() || service?.workspace !== workspace) { return false; }
                const allow = vscode.l10n.t('Allow access for this session');
                const answer = await vscode.window.showWarningMessage(vscode.l10n.t('Allow the KOT agent to access this path?'), {
                    modal: true, detail: vscode.l10n.t('Path: {0}\n\nThe agent may read or change this file or folder and its contents, subject to the current KOT repair policy. Access lasts until the KOT server stops. Agent permission settings will not change.', file)
                }, allow);
                return answer === allow && !disposed && trusted() && service?.workspace === workspace;
            });
            const store = new AgentStore(path.join(directory, 'operations')); await store.recover();
            const environmentClients = new Map<string, VanessaDebugClient>();
            const environmentKey = (file: string) => path.resolve(file).toLocaleLowerCase();
            const ensure = async () => { if (!await dependencies.ensureConnected()) { throw new Error('A compatible Vanessa manager is required.'); } };
            const captureNative = async (): Promise<AgentNativeSource[]> => {
                const native = (await provider.ensureFreshScenarioCatalog()).all.filter(source => path.basename(source.yamlFileUri.fsPath) === 'meta.yaml');
                const captured: AgentNativeSource[] = []; let next = 0;
                await Promise.all(Array.from({ length: Math.min(8, native.length) }, async () => { while (next < native.length) {
                    const source = native[next++];
                    const script = path.join(path.dirname(source.yamlFileUri.fsPath), 'scen.feature'); editable([source.yamlFileUri.fsPath, script]);
                    captured.push({ metadataUri: source.yamlFileUri.toString(), metadata: await fs.readFile(await workspace.resolve(source.yamlFileUri.fsPath), 'utf8'),
                        scriptUri: vscode.Uri.file(script).toString(), script: await fs.readFile(await workspace.resolve(script), 'utf8') });
                } }));
                return captured;
            };
            const nativeMatches = (left: readonly AgentNativeSource[], right: readonly AgentNativeSource[]) => {
                const indexed = new Map(right.map(item => [item.metadataUri, item]));
                return left.length === right.length && left.every(item => {
                    const other = indexed.get(item.metadataUri); return other && other.metadata === item.metadata && other.script === item.script;
                });
            };
            const build = async (selected: readonly AgentTest[]) => {
                if (session.busy) { throw new Error('Wait for the active Vanessa operation before building.'); }
                const sources = selected.filter(test => !/\.feature$/iu.test(test.source)).map(test => vscode.Uri.file(test.source));
                editable(selected.map(test => test.source));
                if (sources.length) {
                    const beforeNative = await captureNative();
                    agentBuilding = true;
                    try {
                        await provider.buildAgentSources(sources); selection = sources.map(uri => uri.toString());
                        const afterNative = await captureNative();
                        if (!nativeMatches(beforeNative, afterNative)) { throw new Error('Native SPPR sources changed during compilation. Rebuild before running.'); }
                        const compiled = await provider.loadVanessaYamlControlBuild(selection);
                        if (!compiled) { throw new Error('Compilation did not publish an exact source manifest.'); }
                        nativeGuard = { sources: afterNative, manifestHash: agentHash(JSON.stringify(compiled.manifest)) };
                    }
                    finally { agentBuilding = false; }
                }
                for (const test of selected.filter(test => /\.feature$/iu.test(test.source))) {
                    const issues = collectGherkinSyntaxErrors(await fs.readFile(test.source, 'utf8'));
                    if (issues.length) { throw new Error('Fix feature syntax before running.'); }
                }
                return { compiled: sources.map(source => source.fsPath), checked: selected.map(test => test.source), report: 'compiler-build-report.md' };
            };
            const attachEnvironment = async (infobase: string, fallback: AgentClientTemplate | undefined, connect: boolean) => {
                const template = await savedClient() ?? fallback;
                const identity = 'KOT-Agent-' + agentHash(infobase).slice(0, 10);
                const name = fallback?.name ?? template?.name ?? identity;
                const client: VanessaDebugClient = { username: '', password: '', clientType: 'Thin', computerName: 'localhost', port: 1538,
                    additionalParameters: '', ...template, id: identity, name, synonym: fallback?.synonym ?? template?.synonym ?? name, infobase };
                await control(entered => session.withTestClientControl(async clients => { entered();
                    const profiles = await clients.list();
                    const other = profiles.filter(profile => profile.connected && normalizeInfobaseConnectionIdentity(profile.connection) !== normalizeInfobaseConnectionIdentity(infobase));
                    if (other.length) { throw new Error('Another test base is connected. Disconnect its client before selecting the agent environment.'); }
                    const connected = profiles.find(profile => profile.connected);
                    if (connected) {
                        if (connected.name === name && matchesVanessaClientSettings(client, connected, false)) { environmentClients.set(environmentKey(infobase), client); return; }
                        throw new Error('The connected client has different user or launch settings. Close it before connecting the selected agent profile.');
                    }
                    const port = await new Promise<number>((resolve, reject) => {
                        const listener = net.createServer(); listener.once('error', reject);
                        listener.listen(0, '127.0.0.1', () => { const address = listener.address(); const port = address && typeof address !== 'string' ? address.port : 0;
                            listener.close(error => error ? reject(error) : port ? resolve(port) : reject(new Error('No test client port is available.'))); });
                    });
                    await clients.apply({ ...client, port }, true); if (connect) { await clients.connect(name); }
                    environmentClients.set(environmentKey(infobase), client);
                }));
            };
            const created = new AgentService(workspace, store, {
                actions: dependencies.actions?.(workspace),
                trusted, canExecute: () => config().get<boolean>('allowExecution', true), tests, manager: dependencies.manager,
                scenarioDescription: (action, source, update) => agentScenarioDescription(workspace, {
                    ...projectLibraryEnvironment(),
                    assertEditable: (files, root) => { editable(files); assertProjectMetadataSaved(root); },
                    replace: async (file, before, after) => {
                        await workspace.resolve(file);
                        const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
                        editable([file]);
                        const editorText = document.getText();
                        if (!nativeDocumentTextMatchesFileText(editorText, before) || readFileSync(file, 'utf8') !== before) { throw new Error('Scenario changed. Read its description again.'); }
                        const edit = new vscode.WorkspaceEdit();
                        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(editorText.length)), after.replace(/^\uFEFF/u, ''));
                        if (!await vscode.workspace.applyEdit(edit)) { throw new Error('Could not update the scenario description.'); }
                        if (!nativeDocumentTextMatchesFileText(document.getText(), after) || !await document.save()) { throw new Error('Could not save the description. Review the retained editor changes.'); }
                    },
                    changed: async files => { await provider.refreshFromExternalStateChange({ refreshCache: true, changedSourceUris: files.map(file => vscode.Uri.file(file)) }); await standalone.refresh(); }
                }, action, source, update),
                launchSettings: async (action, update) => {
                    const manager = YamlParametersManager.getInstance(context); const profile = await manager.loadActiveProfileSnapshot();
                    const revision = agentHash(JSON.stringify(profile));
                    const current = profile.buildParameters.find(item => item.key.toLowerCase() === 'extraparams')?.value ?? '';
                    const before = { profileId: profile.id, profileName: profile.name, revision, additionalParameters: redactVanessaDiagnosticText(current) };
                    if (action === 'read') { return before; }
                    if (session.busy || provider.agentBuildBusy) { throw new Error('Wait for the active build or Vanessa operation.'); }
                    if (update.expectedRevision !== revision) { throw new Error('Build profile changed. Read launch settings again.'); }
                    const value = agentLaunchLocale(current, update.interfaceLanguage, update.locale);
                    const parameters = profile.buildParameters.filter(item => item.key.toLowerCase() !== 'extraparams').map(item => ({ ...item }));
                    parameters.push({ key: 'Extraparams', value });
                    await manager.saveParameters(parameters, profile);
                    return { before, after: { interfaceLanguage: update.interfaceLanguage, locale: update.locale, additionalParameters: redactVanessaDiagnosticText(value) },
                        rebuildRequired: true, clientRestartRequired: true, verified: false };
                },
                definitions: async (query, limit, offset = 0) => {
                    const view = await definitions.ensureReady();
                    const matches = view.all.filter(item => [item.template, item.description, item.scenarioCode].join(' ').toLocaleLowerCase().includes(query));
                    return { identity: view.identity, total: matches.length, nextOffset: offset + limit < matches.length ? offset + limit : undefined, entries: matches.slice(offset, offset + limit)
                        .map(item => ({ id: item.id, kind: item.kind, template: item.template, parameters: item.parameters, description: item.description,
                            definition: item.definitionLocation, implementation: item.implementationLocation, example: item.usageExample })) };
                },
                runtime: () => ({ session: session.snapshot, failure: session.failure, tools: session.formTools,
                    repairPolicy: config().get<string>('repairPolicy', 'tests'), automaticContinuation: 'Requires reconstructed prerequisites; a DT does not restore session context.' }),
                reconcileRun: async (filePath, runId) => {
                    await ensure();
                    if (!session.snapshot.capabilities?.stateJson.supported || !session.snapshot.capabilities.resultsJson.supported) { throw new Error('Structured results are required to reconcile this run.'); }
                    return control(entered => session.withDiagnosticControl(diagnostics => { entered(); return diagnostics.completedRun(filePath, runId); }));
                },
                client: async (action, profileId, name) => {
                    await ensure(); const saved = await new VanessaDebugClientStore(context.workspaceState, context.secrets).loadCatalog();
                    return control(entered => session.withTestClientControl(async clients => { entered();
                        if (action === 'list') { return { saved: saved.map(client => ({ id: client.id, name: client.name, clientType: client.clientType })),
                            live: (await clients.list()).map(client => ({ name: client.name, connected: client.connected, clientType: client.clientType,
                                connection: redactVanessaDiagnosticText(client.connection), port: client.port })) }; }
                        if (action === 'connect') {
                            if (profileId) {
                                const profile = saved.find(client => client.id === profileId); if (!profile) { throw new Error('Select a saved client profile ID.'); }
                                await clients.apply(profile, true); await clients.connect(profile.name); return { connected: profile.name };
                            }
                            if (!name) { throw new Error('Select a saved profile ID or an existing live client name.'); }
                            await clients.connect(name); return { connected: name };
                        }
                        if (!name) { throw new Error('Choose a live client name.'); }
                        if (action === 'close') { await clients.close(name); } else { await clients.disconnect(name); }
                        return { action, name, confirmed: true };
                    }));
                },
                form: async (name, args) => { await ensure(); return session.runFormTool(name, args); },
                screenshot: async title => {
                    await ensure(); return control(entered => session.withDiagnosticControl(async diagnostics => { entered();
                        const windows = await diagnostics.windows();
                        const selected = title ?? (windows.titles.length === 1 ? windows.titles[0] : undefined);
                        if (!selected) { throw new Error('Choose a screenshot window title.'); } return diagnostics.screenshot(windows, selected);
                    }));
                },
                variables: async (action, name, value, scope) => { await ensure(); return control(entered => session.withVariableControl(async variables => { entered();
                    const current = await variables.list();
                    if (action === 'read') { return current; }
                    const previous = current.find(variable => variable.scope === (scope ?? 'local') && variable.name === name);
                    await variables.set(scope ?? 'local', name!, value!, previous?.representation); return { set: true, name, scope: scope ?? 'local' };
                })); },
                build,
                prepare: async selected => {
                    const sources = selected.filter(test => !/\.feature$/iu.test(test.source));
                    if (sources.length) {
                        const native = await captureNative();
                        let fresh = true;
                        for (const test of sources) {
                            try { const compiled = await provider.agentCompiledFeature(vscode.Uri.file(test.source), selection);
                                if (native.length && (!nativeGuard || !nativeMatches(native, nativeGuard.sources) || nativeGuard.manifestHash !== agentHash(JSON.stringify(compiled.sourceMap.manifest)))) { fresh = false; }
                            } catch { fresh = false; }
                        }
                        if (!fresh) { await build(selected); }
                    }
                },
                run: async (test, signal, event, runContext) => {
                    await ensure(); signal.throwIfAborted(); editable([test.source]);
                    let filePath = await workspace.resolve(test.source); let text = await fs.readFile(filePath, 'utf8'); let line = runContext.line ?? 1;
                    let launch: { file: string; text: string } | undefined;
                    let inputs: readonly { uri: string; text: string }[] = [];
                    if (!/\.feature$/iu.test(filePath)) {
                        const compiled = await provider.agentCompiledFeature(vscode.Uri.file(test.source), selection);
                        if (compiled.jsonPath) { launch = { file: await workspace.resolve(compiled.jsonPath), text: await fs.readFile(compiled.jsonPath, 'utf8') }; }
                        const native = nativeGuard?.sources ?? [];
                        if (native.length && nativeGuard!.manifestHash !== agentHash(JSON.stringify(compiled.sourceMap.manifest))) { throw new Error('Native SPPR build evidence changed. Rebuild before running.'); }
                        if (runContext.mode && runContext.mode !== 'full') {
                            const probe = runContext.probeSource ? await workspace.resolve(runContext.probeSource) : test.script ?? test.source;
                            const mapped = mapYamlLineToFeatures(compiled.sourceMap, vscode.Uri.file(probe).toString(), line - 1);
                            const locations = /\.feature$/iu.test(probe) ? mapAgentNativeLine(compiled.sourceMap, native, vscode.Uri.file(probe).toString(), line - 1)
                                : mapped.kind === 'unique' ? [mapped.location] : mapped.kind === 'ambiguous' ? mapped.locations : [];
                            const chosen = locations.length === 1 ? locations[0] : runContext.occurrence === undefined ? undefined : locations[runContext.occurrence];
                            if (!chosen) { throw new Error('Choose one current compiled invocation with occurrence: ' + JSON.stringify(locations)); }
                            filePath = path.join(compiled.sourceMap.outputRoot, ...chosen.feature.split('/')); line = chosen.lineNumber;
                            text = await fs.readFile(filePath, 'utf8');
                        } else { filePath = compiled.filePath; text = compiled.text; }
                        inputs = [...new Map([...compiled.sourceMap.sources, ...native.flatMap(source => [{ uri: source.metadataUri, text: source.metadata },
                            { uri: source.scriptUri, text: source.script }])].map(source => [source.uri, source])).values()];
                    } else {
                        const jsonPath = standalone.getSnapshot().features.find(feature => agentHash(feature.uri) === test.id)?.jsonPath;
                        if (jsonPath) { const file = await workspace.resolve(jsonPath); launch = { file, text: await fs.readFile(file, 'utf8') }; }
                    }
                    if (runContext.mode && runContext.mode !== 'full') {
                        line = resolveVanessaStepLine({ uri: vscode.Uri.file(filePath).toString(), filePath, text, dirty: false, version: 0, line: line - 1 },
                            line - 1, runContext.mode === 'step' ? 'oneStep' : 'runFromLine') + 1;
                    }
                    if (runContext.environment) {
                        const configured = await savedClient();
                        await attachEnvironment(runContext.environment, launch ? agentClientTemplate(launch.text) : undefined, runContext.mode !== 'full' || !launch);
                        await event('client_prepared', { environment: runContext.environment, authentication: configured ? 'saved_profile' : launch ? 'test_launch_json' : 'default',
                            launch: launch ? { path: launch.file, sha256: agentHash(launch.text) } : undefined });
                    }
                    if (collectGherkinSyntaxErrors(text).length) { throw new Error('Fix feature syntax before running.'); }
                    const current = () => {
                        try { return readFileSync(filePath, 'utf8') === text && (!launch || readFileSync(launch.file, 'utf8') === launch.text)
                            && inputs.every(input => readFileSync(vscode.Uri.parse(input.uri).fsPath, 'utf8') === input.text); }
                        catch { return false; }
                    };
                    const projectDirectory = await workspace.resolve(agentProjectDirectory(launch?.text, path.dirname(launch?.file ?? filePath)));
                    if (!(await fs.stat(projectDirectory)).isDirectory()) { throw new Error('The test project directory is not a directory.'); }
                    await control(entered => session.withSettingsControl(async settings => { entered();
                        await event('project_context', { ...await prepareAgentProjectDirectory(settings, projectDirectory), launch: launch?.file });
                    }, current));
                    const generation = session.snapshot.generation; let last = ''; let events = Promise.resolve();
                    const listener = session.onDidChange(snapshot => {
                        const execution = snapshot.execution;
                        if (!execution || execution.filePath.toLocaleLowerCase() !== filePath.toLocaleLowerCase()) { return; }
                        const key = JSON.stringify([execution.status, execution.currentLineNumber, execution.progress]);
                        if (key !== last) { last = key; events = events.then(() => event('progress', { ...execution, steps: undefined })).catch(() => undefined); }
                    });
                    const abort = () => { if (agentRunning) { void session.stop().catch(() => undefined); } }; signal.addEventListener('abort', abort, { once: true });
                    const finishTracking = provider.trackVanessaFeatureRun(filePath, dependencies.runLog());
                    let passed = false;
                    try {
                        await event('source_snapshot', { feature: { path: filePath, text }, sources: inputs });
                        await event('execution_source', { path: filePath, sha256: agentHash(text), source: test.source, mode: runContext.mode ?? 'full', line });
                        signal.throwIfAborted(); agentRunning = true;
                        try { await session.run(runContext.mode === 'step' ? 'oneStep' : runContext.mode === 'fromLine' ? 'runFromLine' : 'runFeature', filePath, line, text, current); }
                        catch (error) {
                            if (session.snapshot.generation !== generation || session.snapshot.execution?.status !== 'failed') { throw error; }
                        }
                        const execution = session.snapshot.execution;
                        const status = session.snapshot.generation === generation && execution?.filePath.toLocaleLowerCase() === filePath.toLocaleLowerCase() && current()
                            ? execution.status : 'unknown';
                        let sourceLocation: unknown;
                        if (session.failure && inputs.length) {
                            try {
                                const mapping = await provider.loadVanessaYamlControlBuild(selection);
                                const artifact = mapping?.artifacts.find(item => path.resolve(mapping.outputRoot, ...item.feature.split('/')).toLocaleLowerCase() === filePath.toLocaleLowerCase());
                                if (mapping && artifact) {
                                    const yaml = mapFeatureLineToYaml(mapping, artifact.worker, artifact.feature, session.failure.lineNumber);
                                    sourceLocation = yaml.kind === 'unmapped' ? mapAgentNativeFailure(mapping, nativeGuard?.sources ?? [], artifact.worker, artifact.feature, session.failure.lineNumber) : yaml;
                                }
                            } catch { sourceLocation = { kind: 'unavailable' }; }
                        }
                        passed = status === 'passed';
                        return { status: status === 'running' ? 'unknown' : status, details: { execution, failure: session.failure, sourceLocation } };
                    } finally { agentRunning = false; signal.removeEventListener('abort', abort); listener.dispose(); await events; await finishTracking(passed).catch(() => undefined); }
                },
                cancel: async () => { if (agentBuilding) { await provider.cancelAgentBuild(); } else if (agentRunning) { await session.stop(); } },
                evidence: async () => {
                    const result: Record<string, unknown> = { session: session.snapshot, failure: session.failure };
                    try { result.form = await control(entered => session.withFormControl(forms => { entered(); return forms.read(); })); } catch { result.formUnavailable = true; }
                    // Client EventLog inspection can open an error dialog when VAExtension is absent.
                    try { result.diagnostics = await control(entered => session.withDiagnosticControl(diagnostics => { entered(); return diagnostics.collect({ managerLog: true }); })); }
                    catch (error) { result.diagnosticsUnavailable = error instanceof Error ? error.message : 'Unavailable'; }
                    const log = dependencies.runLog();
                    if (log) {
                        try { const handle = await fs.open(log, 'r'); try { const stat = await handle.stat(); const buffer = Buffer.alloc(Math.min(stat.size, 256 * 1024));
                            await handle.read(buffer, 0, buffer.length, Math.max(0, stat.size - buffer.length)); result.runLogTail = redactVanessaDiagnosticText(buffer.toString('utf8')); } finally { await handle.close(); } }
                        catch { result.logUnavailable = true; }
                    }
                    return result;
                },
                revision: async () => ({ ...await workspace.revision(), sources: await Promise.all((await tests()).map(async test => ({ source: test.source, sha256: agentHash(await fs.readFile(test.source)) }))) }),
                repair: {
                    maxAttempts: () => config().get<number>('maxRepairAttempts', 3),
                    policy: () => config().get<'read-only' | 'tests' | 'all'>('repairPolicy', 'tests'),
                    classify: async file => {
                        if (!/\.(?:feature|yaml|yml|bsl|os|xml)$/iu.test(file)) { return 'unknown'; }
                        const configuration = getFormExplorerConfigurationSourceDirectory();
                        if (configuration && agentContains(configuration, file)) { return 'configuration'; }
                        if (/\.xml$/iu.test(file)) { return 'unknown'; }
                        if (agentContains(path.resolve(root, getScenarioScanRootPath()), file) || (await tests()).some(test => agentContains(path.dirname(test.source), file))) { return 'test'; }
                        return 'unknown';
                    },
                    assertEditable: editable,
                    changed: async files => { await provider.refreshFromExternalStateChange({ refreshCache: true, changedSourceUris: files.map(file => vscode.Uri.file(file)) }); await standalone.refresh(); },
                    busy: () => session.busy || provider.agentBuildBusy
                },
                infobases: {
                    idle: () => !session.busy && !provider.agentBuildBusy,
                    register: async (infobase, name) => {
                        const result = await registerInfobaseInLauncher(infobase, name);
                        await vscode.commands.executeCommand('kotTestToolkit.refreshInfobaseSidebar');
                        return result;
                    },
                    provenance: async () => ({ revision: await workspace.revision(), platform: (await resolveSharedStartupPlatform(message => message))?.name,
                        session: session.snapshot.server, sourceOfSnapshot: 'exclusive 1C designer operation; saved database data only' }),
                    execute: async (args, log, authenticate = true) => {
                        const platform = await resolveSharedStartupPlatform(message => message);
                        if (!platform) { throw new Error('Configure a 1C platform before preparing an agent environment.'); }
                        const executable = path.join(path.dirname(platform.clientExePath), '1cv8.exe');
                        const targetBase = args.indexOf('/F') >= 0 ? args[args.indexOf('/F') + 1] : undefined;
                        const authentication = authenticate ? await savedClient() ?? (targetBase ? environmentClients.get(environmentKey(targetBase)) : undefined) : undefined;
                        const effective = [...args, ...(authentication?.username ? ['/N', authentication.username] : []),
                            ...(authentication?.password ? ['/P', authentication.password] : [])];
                        if (args[0] === 'DESIGNER' && session.snapshot.capabilities?.clientProfilesRead.supported) {
                            const base = args[args.indexOf('/F') + 1];
                            const profiles = await control(entered => session.withTestClientControl(clients => { entered(); return clients.list(); }));
                            if (profiles.some(profile => profile.connected && normalizeInfobaseConnectionIdentity(profile.connection) === normalizeInfobaseConnectionIdentity(base))) {
                                throw new Error('Close this environment test client before restoring, updating or saving a checkpoint.');
                            }
                        }
                        const output = log + '.' + Date.now();
                        try {
                            await new Promise<void>((resolve, reject) => {
                                const child = spawn(executable, [...effective, '/Out', output], { cwd: root, shell: false, windowsHide: true, stdio: 'ignore' });
                                const timer = setTimeout(() => { child.kill(); reject(new Error('1C environment operation timed out; reconcile its state before retrying.')); }, 30 * 60 * 1000);
                                child.once('error', error => { clearTimeout(timer); reject(error); });
                                child.once('close', code => { clearTimeout(timer); if (code === 0) { resolve(); } else { reject(new Error(`1C environment operation exited with code ${code ?? 'unknown'}. Read its log.`)); } });
                            });
                        } finally {
                            try { await fs.appendFile(log, redactVanessaDiagnosticText(await fs.readFile(output, 'utf8')) + '\n'); } catch { /* A failed process may have no log. */ }
                        }
                    }
                }
            });
            service = created;
            server = new AgentMcpServer({ call: (name, args) => created.call(name, args), trusted });
            try {
                const endpoint = await server.start(); connectionFile = path.join(directory, 'connection.json');
                await fs.writeFile(connectionFile, JSON.stringify({ schemaVersion: 1, ...endpoint }, null, 2), { mode: 0o600 });
                const bridge = path.join(directory, 'agent-mcp.cjs');
                await fs.copyFile(path.join(context.extensionPath, 'out', 'agent-mcp.cjs'), bridge);
                await fs.writeFile(path.join(directory, 'mcp.json'), JSON.stringify({ mcpServers: { kot: { command: 'node', args: [bridge, '--connection', connectionFile] } } }, null, 2));
                const skillDirectory = path.join(directory, 'skills', 'kot-testing');
                await fs.mkdir(skillDirectory, { recursive: true });
                await fs.copyFile(path.join(context.extensionPath, 'res', 'agent', 'kot-testing', 'SKILL.md'), path.join(skillDirectory, 'SKILL.md'));
                showStatus('running', endpoint.url);
                return created;
            } catch (error) { await stop(); throw error; }
        })().catch(error => { showStatus('error'); throw error; }).finally(() => { starting = undefined; });
        return starting;
    };
    const command = (name: string, work: () => Promise<void>) => context.subscriptions.push(vscode.commands.registerCommand(name, async () => {
        if (name === 'kotTestToolkit.agent.setup' && agentSetupRunning) { return; }
        if (name === 'kotTestToolkit.agent.setup') { agentSetupRunning = true; }
        try { await work(); } catch (error) { void vscode.window.showErrorMessage(error instanceof Error ? vscode.l10n.t(error.message) : vscode.l10n.t('KOT agent operation failed.')); }
        finally { if (name === 'kotTestToolkit.agent.setup') { agentSetupRunning = false; } }
    }));
    command('kotTestToolkit.agent.setup', async () => {
        const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        if (!root || !trusted()) { throw new Error(vscode.l10n.t('Open and trust a project folder before connecting AI.')); }
        const client = await vscode.window.showQuickPick([
            { label: 'Codex', description: vscode.l10n.t('Desktop app, IDE extension or CLI'), id: 'codex' as const },
            { label: 'Claude Code', description: vscode.l10n.t('Local Claude Code sessions'), id: 'claude' as const },
            { label: vscode.l10n.t('Other MCP client'), description: vscode.l10n.t('Local agent or shell with MCP over stdio'), id: 'other' as const }
        ], { title: vscode.l10n.t('Connect AI to {0}', path.basename(root)), placeHolder: vscode.l10n.t('1/2 · Choose your AI client') });
        if (!client) { return; }
        const mode = await vscode.window.showQuickPick([
            { label: vscode.l10n.t('Run and repair tests'), description: vscode.l10n.t('Review configuration changes and existing assertions'), policy: 'tests', execution: true },
            { label: vscode.l10n.t('Analysis only'), description: vscode.l10n.t('Read sources and prepare plans without running tests'), policy: 'read-only', execution: false },
            { label: vscode.l10n.t('Run and repair tests and configuration'), description: vscode.l10n.t('Allow product source changes; review existing assertions'), policy: 'all', execution: true }
        ], { title: vscode.l10n.t('AI testing permissions'), placeHolder: vscode.l10n.t('2/2 · Choose what the agent may do') });
        if (!mode) { return; }
        const firstRequest = client.id === 'other'
            ? vscode.l10n.t('Check the KOT connection using kot_project and kot_runtime. Call kot_workflow without a name to list the available workflows. Show the available tests and groups and help me choose the first testing task. Load its workflow before running tests or changing sources, and follow the KOT repair policy.')
            : vscode.l10n.t('Use the kot-testing skill. Check the KOT connection, list the available tests and groups, and help me choose the first testing task.');
        let mcpConfiguration: string | undefined; let instructions: vscode.Uri | undefined;
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Connecting AI to KOT…') }, async progress => {
            await start();
            const directory = path.dirname(connectionFile!);
            const launch = { command: 'node', args: [path.join(directory, 'agent-mcp.cjs'), '--connection', connectionFile!] };
            progress.report({ message: vscode.l10n.t('Checking Node.js and the actual MCP connection…') });
            await checkAgentSetup(launch, root);
            if (!trusted()) { throw new Error(vscode.l10n.t('Open and trust a project folder before connecting AI.')); }
            if (client.id === 'other') {
                mcpConfiguration = JSON.stringify({ mcpServers: { kot: launch } }, null, 2) + '\n';
                instructions = vscode.Uri.file(path.join(directory, 'connect-mcp-client.md'));
                await fs.writeFile(instructions.fsPath, [
                    '# ' + vscode.l10n.t('Connect another MCP client'),
                    vscode.l10n.t('The local KOT bridge has been checked. Complete the connection in your agent or shell using the steps below.'),
                    vscode.l10n.t('1. Add a local MCP server over stdio named kot. Copy the JSON below. If your client uses a different configuration format, enter command and args from mcpServers.kot in its MCP settings.'),
                    '```json\n' + mcpConfiguration.trimEnd() + '\n```',
                    vscode.l10n.t('Keep KOT running in this VS Code project. The MCP client must run on the same computer. Reconnect the client after restarting the KOT server.'),
                    vscode.l10n.t('2. Enable the kot server and accept the client connection prompt if shown. Check that kot_project, kot_runtime and kot_workflow are available.'),
                    vscode.l10n.t('3. Send the first request below. The agent should list real tests and groups, report the Vanessa connection status and list KOT workflows. Skills and MCP prompts are optional: kot_workflow provides the instructions.'),
                    '```text\n' + firstRequest + '\n```'
                ].join('\n\n') + '\n', 'utf8');
            } else {
                editable([path.join(root, client.id === 'codex' ? '.codex/config.toml' : '.mcp.json'), path.join(root, client.id === 'codex' ? '.agents/skills/kot-testing/SKILL.md' : '.claude/skills/kot-testing/SKILL.md')]);
                await configureAgentClient(root, directory, client.id, launch, await fs.readFile(path.join(directory, 'skills/kot-testing/SKILL.md'), 'utf8'));
            }
            await config().update('allowExecution', mode.execution, vscode.ConfigurationTarget.Workspace);
            await config().update('repairPolicy', mode.policy, vscode.ConfigurationTarget.Workspace);
            await config().update('enabled', true, vscode.ConfigurationTarget.Workspace);
        });
        if (instructions) { await vscode.commands.executeCommand('markdown.showPreview', instructions); }
        const copyConfiguration = vscode.l10n.t('Copy MCP configuration');
        const copy = vscode.l10n.t('Copy first request'); const guide = vscode.l10n.t('Open AI testing guide');
        const next = await vscode.window.showInformationMessage(client.id === 'other'
            ? vscode.l10n.t('KOT bridge checked. Follow the opened instructions to connect your MCP client, then send the first request.')
            : vscode.l10n.t('KOT connection checked. Start a new {0} session in this project and accept its connection prompt if shown.', client.label),
        ...(client.id === 'other' ? [copyConfiguration, copy, guide] : [copy, guide]));
        if (next === copyConfiguration && mcpConfiguration) { await vscode.env.clipboard.writeText(mcpConfiguration); }
        if (next === copy) { await vscode.env.clipboard.writeText(firstRequest); }
        if (next === guide) { await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.joinPath(context.extensionUri, 'docs/guides/ai-agent.md')); }
    });
    command('kotTestToolkit.agent.start', async () => { await start(); if (connectionFile) { await vscode.window.showTextDocument(vscode.Uri.file(path.join(path.dirname(connectionFile), 'mcp.json'))); } });
    command('kotTestToolkit.agent.stop', async () => { await starting?.catch(() => undefined); await stop(); });
    command('kotTestToolkit.agent.report', async () => {
        const active = await start(); const records = await active.store.list();
        const selected = await vscode.window.showQuickPick(records.map(record => ({ label: `${record.kind}: ${record.status}`, description: record.id, id: record.id })), { title: vscode.l10n.t('KOT agent reports') });
        if (!selected) { return; } await active.call('kot_report', { id: selected.id });
        await vscode.commands.executeCommand('markdown.showPreview', vscode.Uri.file(path.join(active.store.directory, selected.id, 'report.md')));
    });
    command('kotTestToolkit.agent.approveRepair', async () => {
        const active = await start(); const repairs = (await active.store.list(1000)).filter(record => record.kind === 'repair' && record.status === 'awaiting_approval');
        const selected = await vscode.window.showQuickPick(repairs.map(record => ({ label: String(record.request.reason), description: record.id, id: record.id })), { title: vscode.l10n.t('Review agent repair') });
        if (!selected) { return; }
        const record = await active.store.get(selected.id);
        for (const before of record.artifacts.filter(artifact => artifact.name.startsWith('before-'))) {
            const after = record.artifacts.find(artifact => artifact.name === before.name.replace(/^before-/u, 'after-'));
            if (after) { await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(before.file), vscode.Uri.file(after.file), before.name); }
        }
        const approve = vscode.l10n.t('Approve repair'); const reject = vscode.l10n.t('Reject repair');
        const decision = await vscode.window.showWarningMessage(vscode.l10n.t('Apply this agent repair? Review its source changes and evidence.'), { modal: true }, approve, reject);
        if (decision) { await active.repairs.approve(selected.id, decision === approve); }
    });
    command('kotTestToolkit.agent.run', async () => {
        const active = await start(); const available = await tests();
        const selected = await vscode.window.showQuickPick(available.map(test => ({ label: test.name, description: test.group, detail: test.source, id: test.id })),
            { title: vscode.l10n.t('Choose tests for the agent run'), canPickMany: true });
        if (!selected?.length) { return; }
        const reply = await active.call('kot_run_start', { tests: selected.map(test => test.id), requestKey: 'ui-' + Date.now() });
        void vscode.window.showInformationMessage(vscode.l10n.t('KOT agent operation: {0}', String(reply.structuredContent?.id)));
    });
    command('kotTestToolkit.agent.importCi', async () => {
        const selected = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { ZIP: ['zip'] }, title: vscode.l10n.t('Choose a CI failure archive') });
        if (!selected?.[0]) { return; } selectedArchives.add(selected[0].fsPath);
        const active = await start(); const reply = await active.call('kot_ci_import', { path: selected[0].fsPath, requestKey: 'ui-' + Date.now() });
        void vscode.window.showInformationMessage(vscode.l10n.t('KOT agent operation: {0}', String(reply.structuredContent?.id)));
    });
    command('kotTestToolkit.agent.story', async () => {
        const editor = vscode.window.activeTextEditor;
        const story = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection)
            : await vscode.window.showInputBox({ prompt: vscode.l10n.t('Enter the User Story or select its text in the editor') });
        if (!story) { return; } const active = await start();
        const reply = await active.call('kot_task_create', { kind: 'story', title: vscode.l10n.t('Story testing'), story, requestKey: 'ui-' + Date.now() });
        void vscode.window.showInformationMessage(vscode.l10n.t('KOT agent operation: {0}', String(reply.structuredContent?.id)));
    });
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration('kotTestToolkit.agent.enabled')) {
            if (config().get<boolean>('enabled', false) && trusted()) { void start().catch(error => console.error('[KOT agent]', error)); }
            else { void (async () => { await starting?.catch(() => undefined); await stop(); })(); }
        }
    }), { dispose: () => { disposed = true; if (starting) { void starting.then(stop, stop); } else { void stop(); } } });
    if (trusted() && config().get<boolean>('enabled', false)) { void start().catch(error => console.error('[KOT agent]', error instanceof Error ? error.message : 'Failed')); }
}
