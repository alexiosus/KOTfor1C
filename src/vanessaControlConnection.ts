import { kotWindow } from './kotInteraction';
import * as vscode from 'vscode';
import net from 'node:net';
import { VanessaControlSession, type VanessaControlSnapshot } from './vanessaControlSession';
import { VanessaControlHttpTransport } from './vanessaControlTransport';
import { normalizeVanessaControlEndpoint, assessVanessaControlCapabilities } from './vanessaControlProtocol';
import { awaitVanessaControlReady } from './vanessaControlReadiness';
import { VanessaManagedRun, type VanessaManagedRunRequest, type VanessaManagedRunResult } from './vanessaControlManagedRun';
import fs from 'node:fs/promises';
import { discoverVanessaControlEndpoints, localOneCListeningPorts } from './vanessaControlDiscovery';

const kotUi = kotWindow?.(vscode.window) ?? vscode.window;

const ENDPOINTS = 'kotTestToolkit.vanessaControl.endpoints';
const tokenKey = (endpoint: string) => `kotTestToolkit.vanessaControl.token.${endpoint}`;

/** Native connection UI, shared by the palette, status bar, and Test Manager. */
export function registerVanessaControl(context: vscode.ExtensionContext, options: {
    launch(port: number): Promise<boolean>;
    canAutoStart?(): boolean | Promise<boolean>;
    autoLaunch?(port: number): Promise<boolean>;
    managedRunLog?(port: number): string | undefined;
    attachedRunLog?(endpoint: string): Promise<string | undefined>;
    trackRun?(filePath: string, sessionRunLogPath?: string): (passed: boolean) => Promise<void>;
}): { session: VanessaControlSession; ensureConnected(startWhenAbsent?: boolean): Promise<boolean>; ensureAgentConnected(): Promise<boolean>;
    manager(action: 'list' | 'connect' | 'start', endpoint?: string): Promise<unknown>;
    runLogPath(): string | undefined; runFeature(request: VanessaManagedRunRequest): Promise<VanessaManagedRunResult> } {
    const session = new VanessaControlSession();
    let managedLog: { generation: number; path: string } | undefined;
    let unlinkedLogWarningGeneration: number | undefined;
    const runLogPath = () => managedLog?.generation === session.snapshot.generation ? managedLog.path : undefined;
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 19);
    status.command = 'kotTestToolkit.vanessaControl';
    let launching = false;
    let disposed = false;
    let refreshing = false;
    let launchCancellation: AbortController | undefined;
    let discoveryCancellation: AbortController | undefined;
    let discovery: Promise<readonly string[]> | undefined;
    let automaticAttachment: Promise<void> | undefined;
    let connectionAttempt: Promise<boolean> | undefined;
    let activationAttempted = false;
    const trusted = () => vscode.workspace.isTrusted !== false;
    const labels: Record<VanessaControlSnapshot['status'], string> = {
        detached: vscode.l10n.t('Disconnected'), connecting: vscode.l10n.t('Connecting…'), ready: vscode.l10n.t('Ready'),
        running: vscode.l10n.t('Running'), stopping: vscode.l10n.t('Stopping…'), unknown: vscode.l10n.t('State unavailable')
    };
    const changed = (snapshot: VanessaControlSnapshot) => {
        const requests: Record<string, string> = {
            get_form_analysis: vscode.l10n.t('Reading form…'), user_actions_recording: vscode.l10n.t('Updating recording…'),
            get_vanessa_automation_state: vscode.l10n.t('Checking state…'), get_editor_state: vscode.l10n.t('Reading editor…'),
            run_scenario: vscode.l10n.t('Running'), execute_feature_step: vscode.l10n.t('Executing step…'),
            manage_variables: vscode.l10n.t('Reading or updating variables…'), get_form_element_data: vscode.l10n.t('Reading element…'),
            manage_test_client_profiles: vscode.l10n.t('Reading or updating clients…'), get_test_results: vscode.l10n.t('Reading results…'),
            open_feature_file: vscode.l10n.t('Opening feature…')
        };
        // Idle polling is continuous housekeeping, not an operation the user is waiting for.
        const active = snapshot.request && !snapshot.request.background && snapshot.request.tool !== 'get_vanessa_automation_state' ? snapshot.request : undefined;
        const label = vscode.l10n.t('Vanessa: {0}', active ? requests[active.tool] ?? vscode.l10n.t('Request in progress…') : labels[snapshot.status]);
        status.text = `${active ? '$(loading~spin)' : '$(plug)'} ${label}`;
        status.tooltip = vscode.l10n.t('Vanessa MCP connection and controls');
        if (snapshot.status === 'detached') { status.hide(); } else { status.show(); }
        void vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaControlConnected', !!snapshot.capabilities);
        void vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaControlExecuting', !!snapshot.runActive || snapshot.status === 'running' || snapshot.status === 'stopping');
        void vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaControlCanStop', !!snapshot.capabilities?.stop.supported && snapshot.status !== 'stopping');
    };
    const report = async (work: () => Promise<unknown>) => {
        try { await work(); } catch (error) {
            if (!disposed) { void kotUi.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Vanessa MCP command failed.')); }
        }
    };
    const saved = () => context.workspaceState.get<string[]>(ENDPOINTS, []).filter(value => {
        try { return normalizeVanessaControlEndpoint(value, true) === value; } catch { return false; }
    });
    const remember = async (endpoint: string) => context.workspaceState.update(ENDPOINTS, [endpoint, ...saved().filter(value => value !== endpoint)].slice(0, 10));
    const attach = async (endpoint: string) => {
        const bearerToken = await context.secrets.get(tokenKey(endpoint));
        const allowRemote = true; // Only endpoints explicitly entered/selected in this UI are accepted.
        if (bearerToken && new URL(endpoint).protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname)) {
            throw new Error(vscode.l10n.t('Use HTTPS for a remote authenticated Vanessa endpoint.'));
        }
        const runTimeoutMinutes = vscode.workspace.getConfiguration('kotTestToolkit.agent').get<number>('runTimeoutMinutes', 120);
        const timeoutMs = Number.isFinite(runTimeoutMinutes) ? Math.max(15, Math.min(720, runTimeoutMinutes)) * 60_000 : 900_000;
        await session.attach(new VanessaControlHttpTransport({ allowRemote, bearerToken, initializeTimeoutMs: 3_000, timeoutMs }), endpoint, allowRemote);
        const generation = session.snapshot.generation;
        const address = new URL(endpoint);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(address.hostname);
        const log = local ? options.managedRunLog?.(Number(address.port)) ?? await options.attachedRunLog?.(endpoint).catch(() => undefined) : undefined;
        if (session.snapshot.generation === generation) { managedLog = log ? { generation, path: log } : undefined; }
        await remember(endpoint);
    };
    const cancelDiscovery = () => { discoveryCancellation?.abort(); };
    const find = (): Promise<readonly string[]> => {
        if (discovery) { return discovery; }
        const cancellation = new AbortController(); discoveryCancellation = cancellation;
        discovery = (async () => discoverVanessaControlEndpoints({ saved: saved(), ports: await localOneCListeningPorts(),
            inspect: async (endpoint, signal) => {
                signal.throwIfAborted();
                const transport = new VanessaControlHttpTransport({ initializeTimeoutMs: 1_500,
                    bearerToken: await context.secrets.get(tokenKey(endpoint)) });
                try {
                    await transport.initialize(endpoint, signal);
                    const capabilities = assessVanessaControlCapabilities(await transport.listTools(signal));
                    return capabilities.state.supported && capabilities.editor.supported;
                } finally { await transport.dispose(); }
            } }, cancellation.signal))().finally(() => {
                discovery = undefined; if (discoveryCancellation === cancellation) { discoveryCancellation = undefined; }
            });
        return discovery;
    };
    const autoAttachEnabled = () => vscode.workspace.getConfiguration('kotTestToolkit.vanessaControl').get<boolean>('autoAttach', true);
    const autoStartEnabled = () => vscode.workspace.getConfiguration('kotTestToolkit.vanessaControl').get<boolean>('autoStart', false);
    const autoConnect = async (interactive: boolean): Promise<'attached' | 'none' | 'cancelled'> => {
        if (session.snapshot.capabilities) {
            if (session.snapshot.status !== 'unknown' && (!interactive || session.busy)) { return 'attached'; }
            if (session.busy || launching || disposed) { return 'cancelled'; }
            const previous = session.snapshot.generation;
            // A closed manager can leave a background POST pending. An explicit
            // Connect must not wait for its normal (30 second) request timeout.
            let deadline: ReturnType<typeof setTimeout> | undefined;
            let refreshed: boolean;
            try {
                refreshed = await Promise.race([
                    session.refreshState().then(() => true, () => false),
                    new Promise<boolean>(resolve => { deadline = setTimeout(() => resolve(false), 3_000); deadline.unref(); })
                ]);
            } finally { clearTimeout(deadline); }
            if (disposed || session.snapshot.generation !== previous) { return 'cancelled'; }
            if (session.busy) { return 'cancelled'; }
            if (refreshed && session.snapshot.status !== 'unknown') { return 'attached'; }
            const closing = session.detach(); const detachedGeneration = session.snapshot.generation;
            await closing;
            if (disposed || session.snapshot.generation !== detachedGeneration) { return 'cancelled'; }
        }
        if (!interactive && !autoAttachEnabled() && !autoStartEnabled() || launching || disposed) { return 'none'; }
        const generation = session.snapshot.generation;
        let live: readonly string[];
        try { live = await find(); } catch { return 'cancelled'; }
        if (automaticAttachment) { await automaticAttachment; return 'attached'; }
        if (session.snapshot.capabilities) { return 'attached'; }
        if (disposed || launching || session.snapshot.generation !== generation) { return 'cancelled'; }
        let endpoint = live[0];
        if (live.length > 1) {
            if (!interactive) { return 'cancelled'; }
            const chosen = await kotUi.showQuickPick(live, { title: vscode.l10n.t('Several Vanessa MCP sessions found. Choose the session.'), ignoreFocusOut: true });
            if (!chosen) { return 'cancelled'; }
            endpoint = chosen;
        }
        if (!endpoint) { return 'none'; }
        if (disposed || launching || session.snapshot.generation !== generation || !interactive && !trusted()) { return 'cancelled'; }
        automaticAttachment = attach(endpoint);
        try { await automaticAttachment; return 'attached'; } finally { automaticAttachment = undefined; }
    };
    const attachPicker = async () => {
        if (launching) { return; }
        const automatic = session.snapshot.capabilities && session.snapshot.status !== 'unknown' ? 'none' : await autoConnect(true);
        if (automatic !== 'none') { return; }
        const entries = saved();
        const selected = await kotUi.showQuickPick([
            ...entries.map(endpoint => ({ label: endpoint, endpoint })),
            { label: vscode.l10n.t('Enter MCP endpoint…'), endpoint: '' }
        ], { title: vscode.l10n.t('Attach to Vanessa'), ignoreFocusOut: true });
        if (!selected) { return; }
        let endpoint = selected.endpoint;
        if (!endpoint) {
            const entered = await kotUi.showInputBox({ title: vscode.l10n.t('Vanessa MCP endpoint'),
                value: 'http://127.0.0.1:9876/mcp', ignoreFocusOut: true,
                validateInput: value => { try { normalizeVanessaControlEndpoint(value, true); return undefined; } catch { return vscode.l10n.t('Enter an HTTP(S) endpoint without credentials or query parameters.'); } } });
            if (!entered) { return; }
            endpoint = normalizeVanessaControlEndpoint(entered, true);
        }
        await kotUi.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Connecting to Vanessa…') }, () => attach(endpoint));
    };
    const startConfigured = async (launch: (port: number) => Promise<boolean>): Promise<boolean> => {
        if (disposed || !trusted()) { return false; }
        if (launching || session.busy || ['connecting', 'running', 'stopping'].includes(session.snapshot.status)) { throw new Error(vscode.l10n.t('Vanessa is busy. Wait for the current command.')); }
        cancelDiscovery(); launching = true; launchCancellation = new AbortController();
        const cancellation = launchCancellation;
        try {
            // Reserve a loopback port for this launch; an externally running Vanessa is never reused implicitly.
            const port = await new Promise<number>((resolve, reject) => {
                const server = net.createServer(); server.once('error', reject);
                server.listen(0, '127.0.0.1', () => {
                    const address = server.address(); const number = address && typeof address !== 'string' ? address.port : 0;
                    server.close(error => error ? reject(error) : resolve(number));
                });
            });
            if (disposed || cancellation.signal.aborted || !trusted()) { return false; }
            if (!await launch(port) || disposed || cancellation.signal.aborted) { return false; }
            const endpoint = `http://127.0.0.1:${port}/mcp`;
            await remember(endpoint);
            await kotUi.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
                title: vscode.l10n.t('Waiting for Vanessa MCP…') }, async (_progress, token) => {
                const subscription = token.onCancellationRequested(() => { cancellation.abort(); void session.detach(); });
                if (token.isCancellationRequested) { cancellation.abort(); }
                try {
                    await awaitVanessaControlReady(() => attach(endpoint), cancellation.signal);
                } finally { subscription.dispose(); }
            });
            if (!cancellation.signal.aborted) {
                const path = options.managedRunLog?.(port);
                managedLog = path ? { generation: session.snapshot.generation, path } : undefined;
            }
            return !cancellation.signal.aborted;
        } catch (error) {
            if (!cancellation.signal.aborted) { throw error; }
            await session.detach();
            return false;
        } finally { launching = false; if (launchCancellation === cancellation) { launchCancellation = undefined; } }
    };
    const start = () => startConfigured(options.launch);
    const ensureConnected = async (startWhenAbsent = false): Promise<boolean> => {
        const outcome = await autoConnect(true);
        if (outcome === 'attached') { return true; }
        if (outcome === 'cancelled') { return false; }
        if (startWhenAbsent) { return start(); }
        const startLabel = vscode.l10n.t('Start managed Vanessa'); const enter = vscode.l10n.t('Enter MCP endpoint…');
        const selected = await kotUi.showInformationMessage(vscode.l10n.t('No running Vanessa MCP session found.'), startLabel, enter);
        if (selected === startLabel) { return start(); }
        if (selected === enter) { await attachPicker(); return !!session.snapshot.capabilities; }
        return false;
    };
    const agentManagers = async () => Promise.all((await find()).map(async endpoint => ({ endpoint,
        workspaceManaged: !!(options.managedRunLog?.(Number(new URL(endpoint).port)) ?? await options.attachedRunLog?.(endpoint).catch(() => undefined)),
        connected: session.snapshot.endpoint === endpoint && !!session.snapshot.capabilities })));
    const ensureAgentConnected = async () => {
        if (!trusted()) { throw new Error('Trust this workspace before controlling Vanessa.'); }
        if (session.snapshot.capabilities && session.snapshot.status !== 'unknown') { return true; }
        const live = await agentManagers(); const owned = live.filter(item => item.workspaceManaged);
        const selected = owned.length === 1 ? owned[0] : live.length === 1 ? live[0] : undefined;
        if (selected) { await attach(selected.endpoint); return true; }
        if (live.length) { throw new Error('Several Vanessa managers are available. Select one explicitly with kot_manager before running.'); }
        return start();
    };
    const manager = async (action: 'list' | 'connect' | 'start', endpoint?: string) => {
        if (!trusted()) { throw new Error('Trust this workspace before controlling Vanessa.'); }
        if (action === 'list') { return { managers: await agentManagers(), current: session.snapshot.endpoint }; }
        if (session.busy || launching) { throw new Error('Wait for the active Vanessa operation.'); }
        if (action === 'start') { return { started: await start(), endpoint: session.snapshot.endpoint }; }
        if (!(await find()).includes(endpoint ?? '')) { throw new Error('Choose an available local endpoint from kot_manager.'); }
        await attach(endpoint!); return { connected: session.snapshot.endpoint };
    };
    const connect = (): Promise<boolean> => {
        if (!connectionAttempt) {
            connectionAttempt = Promise.resolve(kotUi.withProgress({ location: vscode.ProgressLocation.Notification,
                title: vscode.l10n.t('Connecting to Vanessa…') }, () => ensureConnected(true)))
                .finally(() => { connectionAttempt = undefined; });
        }
        return connectionAttempt;
    };
    const managed = new VanessaManagedRun({ start: startConfigured,
        currentGeneration: () => !disposed && !session.busy && session.snapshot.status === 'ready' && session.snapshot.capabilities ? session.snapshot.generation : undefined,
        chooseSession: async () => {
            const current = vscode.l10n.t('Run with current session settings');
            const configured = vscode.l10n.t('Prepare configured session');
            const selected = await kotUi.showInformationMessage(vscode.l10n.t('The connected Vanessa session has different or unverified parameters. Choose which settings to use for these test parameters while this session stays connected.'),
                { modal: true }, current, configured);
            return selected === current ? 'current' : selected === configured ? 'configured' : 'cancelled';
        }, run: async (filePath, sourceText, isCurrent, breakpointLines) => {
        if (breakpointLines?.length) { await session.synchronizeBreakpoints(filePath, breakpointLines, isCurrent, sourceText); }
        const log = runLogPath();
        if (!log && options.trackRun && unlinkedLogWarningGeneration !== session.snapshot.generation) {
            unlinkedLogWarningGeneration = session.snapshot.generation;
            void kotUi.showWarningMessage(vscode.l10n.t('This Vanessa session has no linked execution log. For live step highlighting, select Execution log… in the Vanessa menu or start a managed session.'));
        }
        const finish = options.trackRun?.(filePath, log);
        try {
            await session.run('runFeature', filePath, 1, sourceText, isCurrent);
            return session.snapshot.execution?.status === 'running' ? 'unknown' : session.snapshot.execution?.status ?? 'unknown';
        } finally { await finish?.(session.snapshot.execution?.status === 'passed'); }
    } });
    const resume = async () => {
        const execution = session.snapshot.execution;
        if (!execution || execution.stopReason !== 'breakpoint' || execution.status !== 'stopped' || !execution.currentLineNumber) {
            throw new Error(vscode.l10n.t('Continue requires a confirmed breakpoint stop in this feature.'));
        }
        const source = await fs.readFile(execution.filePath, 'utf8'); const generation = session.snapshot.generation;
        await session.run('resume', execution.filePath, execution.currentLineNumber, source, () => generation === session.snapshot.generation);
    };
    const chooseRunLog = async () => {
        if (session.busy || session.snapshot.status !== 'ready') { throw new Error(vscode.l10n.t('Vanessa is busy. Wait for the current command.')); }
        const generation = session.snapshot.generation;
        const files = await kotUi.showOpenDialog({ title: vscode.l10n.t('Select the execution log used by the current Vanessa session'),
            canSelectMany: false, canSelectFolders: false, filters: { Log: ['log', 'txt'] } });
        const file = files?.[0]; if (!file) { return; }
        if (file.scheme !== 'file' || !(await fs.stat(file.fsPath)).isFile()) { throw new Error(vscode.l10n.t('Select a local Vanessa execution log file.')); }
        if (session.snapshot.generation !== generation || session.busy || session.snapshot.status !== 'ready') { throw new Error(vscode.l10n.t('The Vanessa connection changed. Run the test again.')); }
        managedLog = { generation, path: file.fsPath };
    };
    const menu = async (connectionOnly = false) => {
        const snapshot = session.snapshot;
        const picked = await kotUi.showQuickPick([
            { label: vscode.l10n.t('Start managed Vanessa'), detail: vscode.l10n.t('Prepares MCP in the KOT service infobase and opens manual debug.'), action: start },
            { label: vscode.l10n.t('Attach to running Vanessa…'), action: attachPicker },
            ...(connectionOnly ? [
                { label: vscode.l10n.t('Legacy process / Debug launch…'), action: () => vscode.commands.executeCommand('kotTestToolkit.openVanessa') },
                { label: vscode.l10n.t('Saved Debug launch clients…'), action: () => vscode.commands.executeCommand('kotTestToolkit.configureVanessaDebugClients') },
                { label: vscode.l10n.t('Advanced live client actions…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.legacyClients') }
            ] : []),
            ...(!connectionOnly ? [
            { label: vscode.l10n.t('Test clients and saved connections…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.clients') },
            { label: vscode.l10n.t('Vanessa variables…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.variables') },
            ...(snapshot.capabilities?.settingsRead?.supported ? [{ label: vscode.l10n.t('Vanessa session settings…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.settings') }] : []),
            { label: vscode.l10n.t('Diagnostics…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.diagnostics') },
            { label: vscode.l10n.t('Search runtime steps…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.searchRuntimeSteps') },
            { label: vscode.l10n.t('Check feature syntax in Vanessa'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.checkRuntimeSyntax') },
            ] : []),
            ...(snapshot.capabilities ? [
                { label: vscode.l10n.t('Execution log…'), detail: runLogPath() ?? vscode.l10n.t('Select an existing execution log for live step highlighting. This does not change Vanessa settings.'), action: chooseRunLog },
                ...(!connectionOnly ? [
                { label: vscode.l10n.t('Refresh state'), action: () => session.refreshState() },
                { label: vscode.l10n.t('Stop execution'), action: () => session.stop() },
                ...(snapshot.execution?.status === 'stopped' && snapshot.execution.stopReason === 'breakpoint'
                    ? [{ label: vscode.l10n.t('Continue from breakpoint'), action: resume }] : []),
                ] : []),
                { label: vscode.l10n.t('Connection capabilities'), action: async () => {
                    await kotUi.showQuickPick(Object.entries(snapshot.capabilities!).map(([name, value]) => ({
                        label: `${value.supported ? '$(check)' : '$(circle-slash)'} ${name}`, description: value.reason
                    })), { title: vscode.l10n.t('Vanessa capabilities'), placeHolder: `${snapshot.server?.name ?? ''} ${snapshot.server?.version ?? ''}` });
                } },
                { label: vscode.l10n.t('Detach (keep Vanessa open)'), action: () => session.detach() }
            ] : []),
            { label: vscode.l10n.t('Configure endpoint authentication…'), action: async () => {
                const endpoint = await kotUi.showQuickPick(saved(), { title: vscode.l10n.t('Choose endpoint') });
                if (!endpoint) { return; }
                const token = await kotUi.showInputBox({ title: vscode.l10n.t('Bearer token (stored securely)'), password: true,
                    prompt: vscode.l10n.t('Leave empty to remove saved authentication.'), ignoreFocusOut: true });
                if (token === undefined) { return; }
                if (token) { await context.secrets.store(tokenKey(endpoint), token); } else { await context.secrets.delete(tokenKey(endpoint)); }
            } },
            { label: vscode.l10n.t('Forget endpoint…'), action: async () => {
                const endpoint = await kotUi.showQuickPick(saved(), { title: vscode.l10n.t('Forget endpoint') });
                if (endpoint) { await context.workspaceState.update(ENDPOINTS, saved().filter(value => value !== endpoint)); await context.secrets.delete(tokenKey(endpoint)); }
            } }
        ], { title: vscode.l10n.t(connectionOnly ? 'Vanessa connection settings' : 'Control Vanessa'), placeHolder: labels[snapshot.status], matchOnDetail: true });
        await picked?.action();
    };
    context.subscriptions.push(status, session.onDidChange(changed),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.connect', () => report(connect)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.connectionSettings', () => report(() => menu(true))),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl', () => report(menu)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.attach', () => report(attachPicker)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.start', () => report(start)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.stop', () => report(() => session.stop())),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.resume', () => report(resume)),
        vscode.commands.registerCommand('kotTestToolkit.vanessaControl.detach', () => report(() => { cancelDiscovery(); launchCancellation?.abort(); return session.detach(); })),
        { dispose: () => { disposed = true; cancelDiscovery(); launchCancellation?.abort(); clearTimeout(initialDiscovery); clearInterval(timer); void session.detach(); } });
    const timer = setInterval(() => {
        if (disposed || refreshing || !session.snapshot.capabilities?.state.supported) { return; }
        refreshing = true;
        void session.refreshState().catch(() => undefined).finally(() => { refreshing = false; });
    }, 1_000);
    timer.unref(); changed(session.snapshot);
    const initialDiscovery = setTimeout(() => {
        if (activationAttempted || disposed || !trusted()) { return; }
        activationAttempted = true;
        const generation = session.snapshot.generation;
        void (async () => {
            const result = await autoConnect(false);
            const current = () => !disposed && !launching && trusted() &&
                session.snapshot.generation === generation && !session.snapshot.capabilities && autoStartEnabled();
            if (result === 'none' && current() && await options.canAutoStart?.() === true && current()) { await startConfigured(options.autoLaunch ?? options.launch); }
        })().catch(() => undefined);
    }, 500);
    initialDiscovery.unref();
    return { session, ensureConnected, ensureAgentConnected, manager, runLogPath, runFeature: request => managed.run({ ...request,
        breakpointLines: Object.freeze([...session.ownedBreakpointsForSource(request.filePath, request.sourceText)]) }) };
}
