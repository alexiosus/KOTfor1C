import * as vscode from 'vscode';
import net from 'node:net';
import { VanessaControlSession, type VanessaControlSnapshot } from './vanessaControlSession';
import { VanessaControlHttpTransport } from './vanessaControlTransport';
import { normalizeVanessaControlEndpoint, assessVanessaControlCapabilities } from './vanessaControlProtocol';
import { awaitVanessaControlReady } from './vanessaControlReadiness';
import { VanessaManagedRun, type VanessaManagedRunRequest, type VanessaManagedRunResult } from './vanessaControlManagedRun';
import fs from 'node:fs/promises';
import { discoverVanessaControlEndpoints, localOneCListeningPorts } from './vanessaControlDiscovery';

const ENDPOINTS = 'kotTestToolkit.vanessaControl.endpoints';
const tokenKey = (endpoint: string) => `kotTestToolkit.vanessaControl.token.${endpoint}`;

/** Native connection UI, shared by the palette, status bar, and Test Manager. */
export function registerVanessaControl(context: vscode.ExtensionContext, options: {
    launch(port: number): Promise<boolean>;
}): { session: VanessaControlSession; ensureConnected(): Promise<boolean>; runFeature(request: VanessaManagedRunRequest): Promise<VanessaManagedRunResult> } {
    const session = new VanessaControlSession();
    const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 19);
    status.command = 'kotTestToolkit.vanessaControl';
    let launching = false;
    let disposed = false;
    let refreshing = false;
    let launchCancellation: AbortController | undefined;
    let discoveryCancellation: AbortController | undefined;
    let discovery: Promise<readonly string[]> | undefined;
    let automaticAttachment: Promise<void> | undefined;
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
        const active = snapshot.request && snapshot.request.tool !== 'get_vanessa_automation_state' ? snapshot.request : undefined;
        const label = vscode.l10n.t('Vanessa: {0}', active ? requests[active.tool] ?? vscode.l10n.t('Request in progress…') : labels[snapshot.status]);
        status.text = `${active ? '$(loading~spin)' : '$(plug)'} ${label}`;
        status.tooltip = vscode.l10n.t('Vanessa MCP connection and controls');
        if (snapshot.status === 'detached') { status.hide(); } else { status.show(); }
        void vscode.commands.executeCommand('setContext', 'kotTestToolkit.vanessaControlConnected', !!snapshot.capabilities);
    };
    const report = async (work: () => Promise<unknown>) => {
        try { await work(); } catch (error) {
            if (!disposed) { void vscode.window.showErrorMessage(error instanceof Error ? error.message : vscode.l10n.t('Vanessa MCP command failed.')); }
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
        await session.attach(new VanessaControlHttpTransport({ allowRemote, bearerToken, initializeTimeoutMs: 3_000, timeoutMs: 900_000 }), endpoint, allowRemote);
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
    const autoConnect = async (interactive: boolean): Promise<'attached' | 'none' | 'cancelled'> => {
        if (session.snapshot.capabilities) {
            if (session.snapshot.status !== 'unknown') { return 'attached'; }
            if (session.busy || launching || disposed) { return 'cancelled'; }
            const previous = session.snapshot.generation;
            await session.refreshState().catch(() => undefined);
            if (disposed || session.snapshot.generation !== previous) { return 'cancelled'; }
            if (session.snapshot.status !== 'unknown') { return 'attached'; }
            const closing = session.detach(); const detachedGeneration = session.snapshot.generation;
            await closing;
            if (disposed || session.snapshot.generation !== detachedGeneration) { return 'cancelled'; }
        }
        if (!autoAttachEnabled() || launching || disposed) { return 'none'; }
        const generation = session.snapshot.generation;
        let live: readonly string[];
        try { live = await find(); } catch { return 'cancelled'; }
        if (automaticAttachment) { await automaticAttachment; return 'attached'; }
        if (session.snapshot.capabilities) { return 'attached'; }
        if (disposed || launching || session.snapshot.generation !== generation) { return 'cancelled'; }
        let endpoint = live[0];
        if (live.length > 1) {
            if (!interactive) { return 'none'; }
            const chosen = await vscode.window.showQuickPick(live, { title: vscode.l10n.t('Several Vanessa MCP sessions found. Choose the session.'), ignoreFocusOut: true });
            if (!chosen) { return 'cancelled'; }
            endpoint = chosen;
        }
        if (!endpoint) { return 'none'; }
        if (disposed || launching || session.snapshot.generation !== generation) { return 'cancelled'; }
        automaticAttachment = attach(endpoint);
        try { await automaticAttachment; return 'attached'; } finally { automaticAttachment = undefined; }
    };
    const attachPicker = async () => {
        if (launching) { return; }
        const automatic = session.snapshot.capabilities && session.snapshot.status !== 'unknown' ? 'none' : await autoConnect(true);
        if (automatic !== 'none') { return; }
        const entries = saved();
        const selected = await vscode.window.showQuickPick([
            ...entries.map(endpoint => ({ label: endpoint, endpoint })),
            { label: vscode.l10n.t('Enter MCP endpoint…'), endpoint: '' }
        ], { title: vscode.l10n.t('Attach to Vanessa'), ignoreFocusOut: true });
        if (!selected) { return; }
        let endpoint = selected.endpoint;
        if (!endpoint) {
            const entered = await vscode.window.showInputBox({ title: vscode.l10n.t('Vanessa MCP endpoint'),
                value: 'http://127.0.0.1:9876/mcp', ignoreFocusOut: true,
                validateInput: value => { try { normalizeVanessaControlEndpoint(value, true); return undefined; } catch { return vscode.l10n.t('Enter an HTTP(S) endpoint without credentials or query parameters.'); } } });
            if (!entered) { return; }
            endpoint = normalizeVanessaControlEndpoint(entered, true);
        }
        await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Connecting to Vanessa…') }, () => attach(endpoint));
    };
    const startConfigured = async (launch: (port: number) => Promise<boolean>): Promise<boolean> => {
        if (launching || ['connecting', 'running', 'stopping'].includes(session.snapshot.status)) { throw new Error(vscode.l10n.t('Vanessa is busy. Wait for the current command.')); }
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
            if (!await launch(port) || disposed || cancellation.signal.aborted) { return false; }
            const endpoint = `http://127.0.0.1:${port}/mcp`;
            await remember(endpoint);
            await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, cancellable: true,
                title: vscode.l10n.t('Waiting for Vanessa MCP…') }, async (_progress, token) => {
                const subscription = token.onCancellationRequested(() => { cancellation.abort(); void session.detach(); });
                if (token.isCancellationRequested) { cancellation.abort(); }
                try {
                    await awaitVanessaControlReady(() => attach(endpoint), cancellation.signal);
                } finally { subscription.dispose(); }
            });
            return !cancellation.signal.aborted;
        } catch (error) {
            if (!cancellation.signal.aborted) { throw error; }
            await session.detach();
            return false;
        } finally { launching = false; if (launchCancellation === cancellation) { launchCancellation = undefined; } }
    };
    const start = () => startConfigured(options.launch);
    const ensureConnected = async (): Promise<boolean> => {
        const outcome = await autoConnect(true);
        if (outcome === 'attached') { return true; }
        if (outcome === 'cancelled') { return false; }
        const startLabel = vscode.l10n.t('Start managed Vanessa'); const enter = vscode.l10n.t('Enter MCP endpoint…');
        const selected = await vscode.window.showInformationMessage(vscode.l10n.t('No running Vanessa MCP session found.'), startLabel, enter);
        if (selected === startLabel) { return start(); }
        if (selected === enter) { await attachPicker(); return !!session.snapshot.capabilities; }
        return false;
    };
    const managed = new VanessaManagedRun({ start: startConfigured, run: async (filePath, sourceText, isCurrent, breakpointLines) => {
        if (breakpointLines?.length) { await session.synchronizeBreakpoints(filePath, breakpointLines, isCurrent, sourceText); }
        await session.run('runFeature', filePath, 1, sourceText, isCurrent);
        return session.snapshot.execution?.status === 'running' ? 'unknown' : session.snapshot.execution?.status ?? 'unknown';
    } });
    const resume = async () => {
        const execution = session.snapshot.execution;
        if (!execution || execution.stopReason !== 'breakpoint' || execution.status !== 'stopped' || !execution.currentLineNumber) {
            throw new Error(vscode.l10n.t('Continue requires a confirmed breakpoint stop in this feature.'));
        }
        const source = await fs.readFile(execution.filePath, 'utf8'); const generation = session.snapshot.generation;
        await session.run('resume', execution.filePath, execution.currentLineNumber, source, () => generation === session.snapshot.generation);
    };
    const menu = async () => {
        const snapshot = session.snapshot;
        const picked = await vscode.window.showQuickPick([
            { label: vscode.l10n.t('Start managed Vanessa'), detail: vscode.l10n.t('Prepares MCP in the KOT service infobase and opens manual debug.'), action: start },
            { label: vscode.l10n.t('Attach to running Vanessa…'), action: attachPicker },
            { label: vscode.l10n.t('Test clients and saved connections…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.clients') },
            { label: vscode.l10n.t('Runtime variables…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.variables') },
            { label: vscode.l10n.t('Diagnostics…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.diagnostics') },
            { label: vscode.l10n.t('Search runtime steps…'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.searchRuntimeSteps') },
            { label: vscode.l10n.t('Check feature syntax in Vanessa'), action: () => vscode.commands.executeCommand('kotTestToolkit.vanessaControl.checkRuntimeSyntax') },
            ...(snapshot.capabilities ? [
                { label: vscode.l10n.t('Refresh state'), action: () => session.refreshState() },
                { label: vscode.l10n.t('Stop execution'), action: () => session.stop() },
                ...(snapshot.execution?.status === 'stopped' && snapshot.execution.stopReason === 'breakpoint'
                    ? [{ label: vscode.l10n.t('Continue from breakpoint'), action: resume }] : []),
                { label: vscode.l10n.t('Connection capabilities'), action: async () => {
                    await vscode.window.showQuickPick(Object.entries(snapshot.capabilities!).map(([name, value]) => ({
                        label: `${value.supported ? '$(check)' : '$(circle-slash)'} ${name}`, description: value.reason
                    })), { title: vscode.l10n.t('Vanessa capabilities'), placeHolder: `${snapshot.server?.name ?? ''} ${snapshot.server?.version ?? ''}` });
                } },
                { label: vscode.l10n.t('Detach (keep Vanessa open)'), action: () => session.detach() }
            ] : []),
            { label: vscode.l10n.t('Configure endpoint authentication…'), action: async () => {
                const endpoint = await vscode.window.showQuickPick(saved(), { title: vscode.l10n.t('Choose endpoint') });
                if (!endpoint) { return; }
                const token = await vscode.window.showInputBox({ title: vscode.l10n.t('Bearer token (stored securely)'), password: true,
                    prompt: vscode.l10n.t('Leave empty to remove saved authentication.'), ignoreFocusOut: true });
                if (token === undefined) { return; }
                if (token) { await context.secrets.store(tokenKey(endpoint), token); } else { await context.secrets.delete(tokenKey(endpoint)); }
            } },
            { label: vscode.l10n.t('Forget endpoint…'), action: async () => {
                const endpoint = await vscode.window.showQuickPick(saved(), { title: vscode.l10n.t('Forget endpoint') });
                if (endpoint) { await context.workspaceState.update(ENDPOINTS, saved().filter(value => value !== endpoint)); await context.secrets.delete(tokenKey(endpoint)); }
            } }
        ], { title: vscode.l10n.t('Control Vanessa'), placeHolder: labels[snapshot.status], matchOnDetail: true });
        await picked?.action();
    };
    context.subscriptions.push(status, session.onDidChange(changed),
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
    const initialDiscovery = setTimeout(() => { if (vscode.workspace.isTrusted !== false) { void autoConnect(false).catch(() => undefined); } }, 500);
    initialDiscovery.unref();
    return { session, ensureConnected, runFeature: request => managed.run({ ...request,
        breakpointLines: Object.freeze([...session.ownedBreakpointsForSource(request.filePath, request.sourceText)]) }) };
}
