import { getVanessaFormTools, validateVanessaFormToolArguments, type VanessaFormToolDescriptor } from './vanessaControlFormTools';
import { VanessaAuthoringError, VanessaRuntimeAuthoring } from './vanessaControlAuthoring';
import { assessVanessaControlCapabilities, normalizeVanessaControlEndpoint, parseVanessaControlReply, sameVanessaFeaturePath, VanessaEditorSourceMismatchError,
    type VanessaControlCapabilities, type VanessaControlReply } from './vanessaControlProtocol';
import type { VanessaControlProgress, VanessaControlTransport } from './vanessaControlTransport';
import { createHash } from 'node:crypto';
import { VanessaBreakpointReconciler, VanessaBreakpointUnavailableError, type VanessaBreakpointPorts } from './vanessaControlBreakpoints';
import { nativeDocumentTextMatchesFileText } from './scenarioNativeDocumentSnapshot';
import { VanessaRuntimeClients, VanessaClientControlError, parseVanessaClientProfiles } from './vanessaControlClients';
import { VanessaRuntimeVariables, VanessaVariableControlError } from './vanessaControlVariables';
import { VanessaRuntimeForms, VanessaFormControlError, vanessaFormReplyText } from './vanessaControlForms';
import { VanessaDiagnosticError, VanessaRuntimeDiagnostics, type VanessaDiagnosticTool } from './vanessaControlDiagnostics';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { mapVanessaStepResults, type VanessaExecutionLine } from './vanessaControlStepResults';

export interface VanessaControlExecution {
    readonly filePath: string;
    readonly lineNumber: number;
    readonly currentLineNumber?: number;
    /** Next editor selection reported by Vanessa, not an inferred executor position. */
    readonly nextLineNumber?: number;
    readonly stopReason?: 'breakpoint';
    readonly mode: 'oneStep' | 'runFromLine' | 'runFeature' | 'resume';
    readonly status: 'running' | 'passed' | 'failed' | 'stopped' | 'unknown';
    readonly progress?: VanessaControlProgress;
    readonly steps?: readonly VanessaExecutionLine[];
}

export interface VanessaControlSnapshot {
    readonly generation: number;
    readonly status: 'detached' | 'connecting' | 'ready' | 'running' | 'stopping' | 'unknown';
    readonly endpoint?: string;
    readonly server?: Readonly<{ name: string; version: string }>;
    readonly capabilities?: VanessaControlCapabilities;
    readonly observed?: Extract<VanessaControlReply, { kind: 'state' }>;
    readonly error?: 'connection' | 'request' | 'tool' | 'format';
    readonly execution?: VanessaControlExecution;
    readonly request?: Readonly<{ tool: string; count: number }>;
    readonly breakpoints?: Readonly<{ filePath: string; lines: readonly number[]; ownedLines: readonly number[] }>;
}

interface RunRequest {
    readonly generation: number;
    readonly controller: AbortController;
    stopRequested: boolean;
    confirmedStop: boolean;
    executing?: boolean;
}
export interface VanessaControlFailure { readonly generation: number; readonly filePath: string; readonly lineNumber: number; readonly message: string }
/** An ancillary MCP error must still reject the command without erasing its confirmed failure. */
class VanessaConfirmedRunFailureError extends Error {}
function safeFailureText(value: string): string {
    return value.slice(0, 8_000).replace(/\b(Pwd|Password|Пароль)\s*=\s*(?:"[^"]*"|'[^']*'|[^;\s]+)/giu, '$1=***')
        .replace(/\/P(?:"[^"]*"|[^\s]+)/giu, '/P***').replace(/Bearer\s+[^\s]+/giu, 'Bearer ***').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
}
function commandFailureText(result: Awaited<ReturnType<VanessaControlTransport['callTool']>>): string | undefined {
    const text = result.content?.filter(item => item.type === 'text').map(item => 'text' in item ? item.text : '').join('\n').replace(/\r\n/gu, '\n');
    // The one-step failure reply starts with the short error, then appends live UI data.
    return text?.split(/\n(?:Заголовок активного окна:|## |Технические данные:)/u)[0].trim() || undefined;
}

/** Owns the connection, never the attached 1C process. Credentials stay in the transport. */
export class VanessaControlSession {
    private readonly requests = new Map<symbol, string>();
    private value: VanessaControlSnapshot = Object.freeze({ generation: 0, status: 'detached' });
    private wire?: VanessaControlTransport;
    private advertisedFormTools: readonly VanessaFormToolDescriptor[] = Object.freeze([]);
    get formTools(): readonly VanessaFormToolDescriptor[] { return this.advertisedFormTools; }
    private lifetime?: AbortController;
    private mutation = false;
    private refresh?: Promise<void>;
    private runRequest?: RunRequest;
    private readonly breakpointSync = new VanessaBreakpointReconciler();
    private readonly runningLines = new Set<number>();
    private failureValue?: VanessaControlFailure;
    private resumeSource?: { generation: number; filePath: string; lineNumber: number; hash: string };
    private executionSource?: { generation: number; filePath: string; text: string };
    private breakpointSource?: { generation: number; filePath: string; text: string };
    /** Details are local to explicit editor control, excluded from public Test Manager state/logs. */
    get failure(): VanessaControlFailure | undefined { return this.failureValue; }
    executionMatchesSource(filePath: string, text: string): boolean {
        const source = this.executionSource;
        return !!source && source.generation === this.value.generation && sameVanessaFeaturePath(filePath, source.filePath) &&
            (source.text === text || nativeDocumentTextMatchesFileText(text, source.text));
    }
    ownedBreakpointsForSource(filePath: string, text: string): readonly number[] {
        const source = this.breakpointSource; const points = this.value.breakpoints;
        return source?.generation === this.value.generation && points && sameVanessaFeaturePath(filePath, source.filePath) &&
            (source.text === text || nativeDocumentTextMatchesFileText(text, source.text)) ? points.ownedLines : [];
    }
    private readonly listeners = new Set<(snapshot: VanessaControlSnapshot) => void>();
    get busy(): boolean { return this.mutation || this.value.status === 'running' || this.value.status === 'stopping'; }
    get snapshot(): VanessaControlSnapshot { return this.value; }
    readonly onDidChange = (listener: (snapshot: VanessaControlSnapshot) => void): { dispose(): void } => {
        this.listeners.add(listener); return { dispose: () => this.listeners.delete(listener) };
    };

    async attach(wire: VanessaControlTransport, endpoint: string, allowRemote = false): Promise<void> {
        const normalized = normalizeVanessaControlEndpoint(endpoint, allowRemote);
        const closing = this.detach();
        const generation = this.value.generation;
        await closing;
        this.checkGeneration(generation);
        this.wire = wire; this.lifetime = new AbortController();
        this.set({ generation, status: 'connecting', endpoint: normalized });
        try {
            const server = await wire.initialize(normalized, this.lifetime.signal);
            this.checkGeneration(generation);
            const tools = await wire.listTools(this.lifetime.signal);
            this.checkGeneration(generation);
            this.advertisedFormTools = getVanessaFormTools(tools);
            this.set({ ...this.value, server: Object.freeze({ ...server }), capabilities: assessVanessaControlCapabilities(tools), status: 'unknown' });
            await this.refreshState();
        } catch {
            if (this.value.generation === generation) {
                this.set({ generation, endpoint: normalized, status: 'unknown', error: 'connection' });
                this.lifetime?.abort(); this.wire = undefined;
                await wire.dispose().catch(() => undefined);
            }
            throw new Error('Could not connect to Vanessa MCP. Check the endpoint and compatible components.');
        }
    }

    async detach(): Promise<void> {
        this.requests.clear();
        this.advertisedFormTools = Object.freeze([]);
        const old = this.wire;
        this.wire = undefined; this.lifetime?.abort(); this.lifetime = undefined;
        this.mutation = false; this.refresh = undefined;
        this.runRequest = undefined;
        this.breakpointSync.reset();
        this.runningLines.clear();
        this.failureValue = undefined;
        this.resumeSource = undefined;
        this.executionSource = undefined; this.breakpointSource = undefined;
        this.set({ generation: this.value.generation + 1, status: 'detached' });
        await old?.dispose().catch(() => undefined);
    }

    /** Explicit form actions use only this attachment's advertised schemas. Results stay local. */
    async runFormTool(name: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
        const tool = this.advertisedFormTools.find(item => item.name === name);
        if (!tool) { throw new VanessaFormControlError('This form tool is not available in the attached Vanessa session.'); }
        const validated = validateVanessaFormToolArguments(tool, args);
        let result: unknown;
        await this.mutate(async generation => {
            try { result = await this.invoke(tool.name, validated, generation); this.checkGeneration(generation); }
            catch { throw new VanessaFormControlError('The Vanessa form tool request could not be confirmed. Refresh the connection before retrying.'); }
        }, false);
        return result;
    }

    async withTestClientControl<T>(work: (clients: VanessaRuntimeClients) => Promise<T>, isCurrent?: () => boolean): Promise<T> {
        let result!: T;
        await this.mutate(async generation => {
            const current = () => this.value.generation === generation && (!isCurrent || isCurrent());
            const clients = new VanessaRuntimeClients({ isCurrent: current, request: async (operation, fields = {}) => {
                const capability = operation === 'list' ? 'clientProfilesRead' : operation === 'add' || operation === 'edit' ? 'clientProfilesWrite'
                    : operation === 'connect' ? 'clientConnect' : operation === 'disconnect' ? 'clientDisconnect' : 'clientClose';
                this.require(capability);
                const tool = operation === 'list' || operation === 'add' || operation === 'edit' ? 'manage_test_client_profiles'
                    : operation === 'close' ? 'close_test_client' : 'manage_test_client';
                const args = operation === 'list' ? { action: 'get_list' } : operation === 'add' || operation === 'edit' ? { ...fields, action: operation }
                    : operation === 'close' ? { profileName: fields.name } : operation === 'connect' ? { action: operation, profileName: fields.name } : { action: operation };
                return this.invoke(tool, args, generation);
            } });
            result = await work(clients);
            this.checkGeneration(generation);
        });
        return result;
    }

    async withVariableControl<T>(work: (variables: VanessaRuntimeVariables) => Promise<T>, isCurrent?: () => boolean): Promise<T> {
        let result!: T;
        await this.mutate(async generation => {
            const variables = new VanessaRuntimeVariables({
                isCurrent: () => this.value.generation === generation && (!isCurrent || isCurrent()),
                request: async args => {
                    this.require(args.action === 'get' ? 'variablesRead' : 'variablesWrite');
                    return this.invoke('manage_variables', { ...args }, generation);
                }
            });
            result = await work(variables);
            this.checkGeneration(generation);
        });
        return result;
    }

    async withAuthoringControl<T>(work: (authoring: VanessaRuntimeAuthoring) => Promise<T>, isCurrent?: () => boolean): Promise<T> {
        let result!: T;
        await this.mutate(async generation => {
            const current = () => this.value.generation === generation && (!isCurrent || isCurrent());
            const client = async () => {
                this.require('clientProfilesRead');
                const connected = parseVanessaClientProfiles(await this.invoke('manage_test_client_profiles', { action: 'get_list' }, generation)).filter(profile => profile.connected);
                if (connected.length !== 1) { throw new VanessaAuthoringError('Connect one test client before recording or reading form steps.'); }
                return createHash('sha256').update(JSON.stringify([generation, connected[0]])).digest('hex');
            };
            result = await work(new VanessaRuntimeAuthoring({ generation, isCurrent: current, client,
                formIdentity: async () => {
                    this.require('formWindow'); const owner = await client();
                    const title = vanessaFormReplyText(await this.invoke('get_active_window_data', { type: 'window_caption' }, generation));
                    const form = vanessaFormReplyText(await this.invoke('get_active_window_data', { type: 'form_name' }, generation));
                    if (!title || !form || /[\r\n\u0000]/u.test(title + form)) { throw new VanessaAuthoringError('The current client form was not confirmed.'); }
                    return JSON.stringify([owner, title, form]);
                }, request: (tool, args) => {
                    this.require(tool === 'user_actions_recording' ? 'recording' : tool === 'get_vanessa_automation_state' ? 'state' : args.format === 'gherkin' ? 'formChecks' : 'formSuggestions');
                    return this.invoke(tool, args, generation);
                } }));
            this.checkGeneration(generation);
        }, false);
        return result;
    }

    async withDiagnosticControl<T>(work: (diagnostics: VanessaRuntimeDiagnostics) => Promise<T>): Promise<T> {
        let result!: T;
        await this.mutate(async generation => {
            const capabilities: Record<VanessaDiagnosticTool, keyof VanessaControlCapabilities> = {
                get_vanessa_automation_state: 'state', get_environment_data: 'environment', manage_test_client_profiles: 'clientProfilesRead',
                get_test_results: 'results', get_event_log_manager: 'managerLog', get_event_log_test_client: 'clientLog',
                search_for_steps_by_keywords: 'runtimeSearch', check_syntax: 'runtimeSyntax', get_window_list_os: 'screenshotWindows', get_window_screenshot_os: 'screenshot'
            };
            result = await work(new VanessaRuntimeDiagnostics({ isCurrent: () => this.value.generation === generation,
                supported: tool => !!this.value.capabilities?.[capabilities[tool]].supported,
                request: (tool, args, signal) => { this.require(capabilities[tool]); return this.invoke(tool, args, generation, signal); },
                screenshotFile: this.value.endpoint && ['localhost', '127.0.0.1', '[::1]'].includes(new URL(this.value.endpoint).hostname) ? async capture => {
                    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'kot-vanessa-screenshot-'));
                    const file = path.join(directory, 'capture.png');
                    try {
                        const inline = await capture(file); this.checkGeneration(generation);
                        if (inline) { return inline; }
                        const stat = await fs.lstat(file);
                        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 24_000_000) { throw new VanessaDiagnosticError('Vanessa did not return a supported PNG screenshot.'); }
                        const data = await fs.readFile(file); this.checkGeneration(generation); return data;
                    } finally { await fs.rm(directory, { recursive: true, force: true }).catch(() => undefined); }
                } : undefined
            }));
            this.checkGeneration(generation);
        }, false);
        return result;
    }

    async withFormControl<T>(work: (forms: VanessaRuntimeForms) => Promise<T>, isCurrent?: () => boolean): Promise<T> {
        let result!: T;
        await this.mutate(async generation => {
            for (const capability of ['formTree', 'formWindow', 'clientProfilesRead'] as const) { this.require(capability); }
            const forms = new VanessaRuntimeForms({
                isCurrent: () => this.value.generation === generation && (!isCurrent || isCurrent()),
                identity: async () => {
                    const profiles = parseVanessaClientProfiles(await this.invoke('manage_test_client_profiles', { action: 'get_list' }, generation));
                    const connected = profiles.filter(profile => profile.connected);
                    if (connected.length !== 1) { throw new VanessaFormControlError('Form Explorer needs one connected test client. Select a client in Vanessa, then refresh.'); }
                    const read = async (type: string) => {
                        const value = vanessaFormReplyText(await this.invoke('get_active_window_data', { type }, generation));
                        if (!value || value.length > 4_096 || /[\r\n\u0000]/u.test(value)) { throw new VanessaFormControlError('The active Vanessa window was not confirmed. Refresh the form.'); }
                        return value;
                    };
                    return { client: createHash('sha256').update(JSON.stringify([generation, connected[0]])).digest('hex'),
                        windowTitle: await read('window_caption'), formName: await read('form_name') };
                },
                request: (tool, args) => {
                    if (tool === 'manage_form_elements') {
                        const advertised = this.formTools.find(item => item.name === tool);
                        if (!advertised) { throw new VanessaFormControlError('This Vanessa session does not expose element activation through MCP.'); }
                        validateVanessaFormToolArguments(advertised, args);
                    } else { this.require(tool === 'get_form_analysis' ? 'formTree' : tool === 'get_form_element_data' ? 'formElement' : tool === 'get_window_list_testclient' ? 'formWindows' : 'formActivateWindow'); }
                    return this.invoke(tool, { ...args }, generation);
                }
            });
            result = await work(forms); this.checkGeneration(generation);
        }, false);
        return result;
    }

    async refreshState(): Promise<void> {
        if (this.refresh) { return this.refresh; }
        this.require('state');
        const generation = this.value.generation;
        const observedRun = this.runRequest?.executing ? this.runRequest : undefined;
        const operation = (async () => {
            try {
                const result = await this.invoke('get_vanessa_automation_state', {}, generation);
                const observed = parseVanessaControlReply('get_vanessa_automation_state', result);
                if (observed.kind === 'state') {
                    const execution = this.value.execution;
                    let confirmed = execution;
                    if (execution && observed.featurePath && sameVanessaFeaturePath(execution.filePath, observed.featurePath) && observed.lineNumber) {
                        if (this.runRequest && observed.state === 'running' && observed.stepStatus === 'running') {
                            this.runningLines.add(observed.lineNumber);
                            confirmed = Object.freeze({ ...execution, currentLineNumber: observed.lineNumber });
                        }
                        if (this.runningLines.has(observed.lineNumber) && ['failed', 'stopped'].includes(observed.stepStatus ?? '') &&
                            (execution.mode !== 'oneStep' || execution.lineNumber === observed.lineNumber)) {
                            confirmed = Object.freeze({ ...execution, currentLineNumber: observed.lineNumber, status: observed.stepStatus as 'failed' | 'stopped' });
                        }
                        if (observedRun && observedRun === this.runRequest && ['passed', 'failed', 'stopped'].includes(observed.stepStatus ?? '') &&
                            (execution.mode !== 'oneStep' || execution.lineNumber === observed.lineNumber)) {
                            confirmed = Object.freeze({ ...confirmed!, steps: Object.freeze([...(confirmed?.steps ?? []).filter(step => step.lineNumber !== observed.lineNumber),
                                { lineNumber: observed.lineNumber, status: observed.stepStatus as 'passed' | 'failed' | 'stopped' }]) });
                        }
                    }
                    this.set({ ...this.value, observed: Object.freeze(observed), error: undefined,
                        execution: confirmed,
                        status: this.mutation ? this.value.status : observed.state === 'running' ? 'running' : 'ready' });
                    const request = this.runRequest;
                    if (request?.generation === generation && request.stopRequested && confirmed?.status === 'stopped' && observed.state === 'idle') {
                        // Vanessa .45 can leave run_scenario unanswered after Stop. Only an
                        // observed terminal step from this run permits cancelling that POST.
                        request.confirmedStop = true;
                        request.controller.abort();
                    }
                } else {
                    this.set({ ...this.value, observed: undefined, status: this.mutation ? this.value.status : 'unknown', error: observed.kind === 'toolError' ? 'tool' : 'format' });
                }
            } catch {
                if (this.value.generation === generation) { this.set({ ...this.value, observed: undefined, status: 'unknown', error: 'request' }); }
                throw new Error('Could not read Vanessa state.');
            }
        })();
        this.refresh = operation;
        try { await operation; } finally { if (this.refresh === operation) { this.refresh = undefined; } }
    }

    async select(filePath: string, lineNumber: number): Promise<void> {
        this.validateStep(filePath, lineNumber); this.require('openFeature'); this.require('selectStep');
        await this.mutate(async generation => {
            this.runningLines.clear();
            await this.invokeChecked('open_feature_file', { filePath }, generation);
            await this.invokeChecked('select_step', { lineNumber }, generation);
        });
    }

    async run(mode: VanessaControlExecution['mode'], filePath: string, lineNumber: number, sourceText?: string, isCurrent?: () => boolean): Promise<void> {
        this.validateStep(filePath, lineNumber);
        if (mode === 'resume') {
            const previous = this.value.execution;
            if (previous?.status !== 'stopped' || previous.stopReason !== 'breakpoint' || previous.currentLineNumber !== lineNumber ||
                !sameVanessaFeaturePath(previous.filePath, filePath)) { throw new Error('Continue requires a confirmed breakpoint stop in this feature.'); }
            if (!sourceText || this.resumeSource?.generation !== this.value.generation || this.resumeSource.lineNumber !== lineNumber ||
                !sameVanessaFeaturePath(this.resumeSource.filePath, filePath) || this.resumeSource.hash !== createHash('sha256').update(sourceText).digest('hex')) {
                throw new Error('The feature source changed since the breakpoint stop. Start a new run explicitly.');
            }
        }
        this.require(mode === 'resume' ? 'runCurrent' : mode);
        if (sourceText !== undefined) { this.require('editorContent'); this.require('openFeature'); }
        if (sourceText !== undefined && mode === 'runFromLine') { this.require('selectStep'); this.require('runCurrent'); }
        if (sourceText !== undefined && mode === 'runFeature') { this.require('runAll'); }
        const withBreakpoints = (mode === 'runFromLine' || mode === 'runFeature') && !!this.value.breakpoints?.lines.length && sameVanessaFeaturePath(filePath, this.value.breakpoints.filePath);
        if (withBreakpoints) { for (const capability of ['loadFeature', 'openFeature', 'editor', 'selectStep', 'runCurrent'] as const) { this.require(capability); } }
        if (withBreakpoints && mode === 'runFeature') { this.require('runAll'); }
        await this.mutate(async generation => {
            const assertSource = () => { if (isCurrent && !isCurrent()) { throw new Error('The active feature changed.'); } };
            assertSource();
            const previousSteps = mode === 'oneStep' && sourceText !== undefined && this.executionMatchesSource(filePath, sourceText)
                ? this.value.execution?.steps?.filter(step => step.lineNumber !== lineNumber) : undefined;
            this.runningLines.clear();
            this.failureValue = undefined;
            this.resumeSource = undefined;
            this.executionSource = sourceText === undefined ? undefined : { generation, filePath, text: sourceText };
            this.set({ ...this.value, status: 'running', error: undefined,
                execution: Object.freeze({ filePath, lineNumber, mode, status: 'running', ...(previousSteps?.length ? { steps: previousSteps } : {}) }) });
            const tool = mode === 'oneStep' ? 'execute_feature_step' : 'run_scenario';
            const request: RunRequest = { generation, controller: new AbortController(), stopRequested: false, confirmedStop: false };
            this.runRequest = request;
            try {
                const before = this.value.capabilities?.results.supported ? await this.readResults(generation) : undefined;
                assertSource();
                const source = sourceText === undefined ? undefined : { filePath, text: sourceText };
                if (source && !withBreakpoints) {
                    const loadForRun = mode === 'runFeature' || mode === 'runFromLine';
                    if (loadForRun) { await this.invokeChecked('open_feature_file', { filePath }, generation); }
                    let editor;
                    try { editor = await this.readEditor(generation, source, !loadForRun); }
                    catch (error) {
                        if (!(error instanceof VanessaEditorSourceMismatchError) || mode === 'resume') { throw error; }
                        editor = await this.reloadSavedFeature(generation, source, isCurrent);
                    }
                    if (!editor || !sameVanessaFeaturePath(filePath, editor.featurePath)) {
                        if (mode === 'resume') { throw new VanessaEditorSourceMismatchError(); }
                        await this.invokeChecked('open_feature_file', { filePath }, generation);
                        editor = await this.readEditor(generation, source);
                    }
                    if (!editor || !sameVanessaFeaturePath(filePath, editor.featurePath)) { throw new VanessaEditorSourceMismatchError(); }
                    if (mode === 'resume' && editor.lineNumber !== lineNumber) { throw new Error('Vanessa moved away from the confirmed breakpoint. Select a step explicitly.'); }
                    if (mode === 'runFromLine') {
                        await this.invokeChecked('select_step', { lineNumber }, generation);
                        const selected = await this.readEditor(generation, source);
                        if (!selected || selected.dirty || !sameVanessaFeaturePath(filePath, selected.featurePath) || selected.lineNumber !== lineNumber) {
                            throw new Error('Vanessa did not select the requested feature step.');
                        }
                    }
                }
                if (mode === 'resume' && !source) { throw new Error('Continue requires the current saved feature content.'); }
                let points: readonly number[] = [];
                if (mode === 'resume') {
                    points = await this.breakpointSync.reconcile({ generation, filePath }, undefined, this.breakpointPorts(generation, isCurrent, source));
                    this.publishBreakpoints(filePath, points, generation);
                }
                if (withBreakpoints) {
                    const ports = this.breakpointPorts(generation, isCurrent, source);
                    const active = await ports.editor();
                    if (!active || !sameVanessaFeaturePath(filePath, active.featurePath)) { await this.invokeChecked('open_feature_file', { filePath }, generation); }
                    const target = { generation, filePath };
                    points = await this.breakpointSync.reconcile(target, undefined, ports);
                    const owned = this.breakpointSync.ownedLines(target);
                    assertSource();
                    await this.invokeChecked('load_features', { path: filePath }, generation);
                    await this.invokeChecked('open_feature_file', { filePath }, generation);
                    if (mode !== 'runFeature') { await this.invokeChecked('select_step', { lineNumber }, generation); }
                    // Reload clears foreign points too. Restore the captured same-file state even
                    // if the local source tab switched meanwhile; the final guard still blocks execution.
                    points = await this.breakpointSync.restore(target, points, owned, this.breakpointPorts(generation, undefined, source));
                    this.publishBreakpoints(filePath, points, generation);
                    const selected = await ports.editor();
                    if (!selected || selected.dirty || !sameVanessaFeaturePath(filePath, selected.featurePath) || mode !== 'runFeature' && selected.lineNumber !== lineNumber) {
                        throw new Error('Vanessa did not select the requested feature step.');
                    }
                }
                assertSource();
                if (request.stopRequested) { throw new Error('Execution was cancelled before launch.'); }
                const args = mode === 'resume' ? { mode: 'fromCurrentStep' }
                    : withBreakpoints ? { mode: mode === 'runFeature' ? 'all' : 'fromCurrentStep' }
                        : source && (mode === 'runFeature' || mode === 'runFromLine') ? { mode: mode === 'runFeature' ? 'all' : 'fromCurrentStep' }
                        : mode === 'runFeature' ? { filePath, mode: 'reloadAndRun' }
                            : { filePath, lineNumber, ...(mode === 'runFromLine' ? { mode: 'reloadAndRunFromLine' } : {}) };
                request.executing = true;
                const result = await this.invoke(tool, args, generation, request.controller.signal);
                const parsed = parseVanessaControlReply(tool, result);
                let status: VanessaControlExecution['status'] = ['failed', 'stopped'].includes(this.value.execution!.status) ? this.value.execution!.status
                    : parsed.kind === 'stepResult' || parsed.kind === 'runResult' ? parsed.status : 'unknown';
                // .45 can acknowledge an unknown/Pending step as successful. Read actual
                // post-command state and results even when execute_feature_step says success.
                // A background poll issued before the command may still describe its predecessor.
                // Drain it, then require an observation requested after this command completed.
                const previousObservation = this.refresh;
                if (previousObservation) { await previousObservation.catch(() => undefined); }
                this.checkGeneration(generation);
                let stateError: unknown;
                try { await this.refreshState(); }
                catch (error) { this.checkGeneration(generation); stateError = error; }
                const observed = this.value.observed;
                const matches = observed?.featurePath && sameVanessaFeaturePath(filePath, observed.featurePath) &&
                    (mode !== 'oneStep' || observed.lineNumber === lineNumber);
                const after = this.value.capabilities?.results.supported ? await this.readResults(generation) : undefined;
                if (matches && ['failed', 'pending'].includes(observed.stepStatus ?? '')) { status = 'failed'; }
                if (after && matches && after.parsed.kind === 'runtimeResult' && after.parsed.status !== 'passed' &&
                    (after.hash !== before?.hash || ['failed', 'pending'].includes(observed.stepStatus ?? ''))) {
                    status = 'failed';
                    if (after.parsed.message) { this.failureValue = Object.freeze({ generation, filePath, lineNumber: observed.lineNumber ?? lineNumber, message: safeFailureText(after.parsed.message) }); }
                }
                if (before && after && after.hash !== before.hash && after.parsed.kind === 'failureResult' && sameVanessaFeaturePath(filePath, after.parsed.featurePath) &&
                    (mode !== 'oneStep' || lineNumber === after.parsed.lineNumber)) {
                    status = 'failed';
                    this.failureValue = Object.freeze({ generation, filePath, lineNumber: after.parsed.lineNumber,
                        message: safeFailureText(after.message ?? 'Vanessa reported a failed step without an error description.') });
                }
                if (status === 'failed' && !this.failureValue) {
                    const message = after?.message ?? (parsed.kind !== 'stepResult' && parsed.kind !== 'runResult' ? commandFailureText(result) : undefined)
                        ?? 'Vanessa reported a failed step without an error description.';
                    this.failureValue = Object.freeze({ generation, filePath, lineNumber: matches ? observed.lineNumber ?? lineNumber : lineNumber, message: safeFailureText(message) });
                }
                if (stateError && status !== 'failed') { throw stateError; }
                let stopLine: number | undefined;
                if (status === 'unknown' && !result.isError && points.length && this.runningLines.size) {
                    await this.refreshState();
                    const observed = this.value.observed;
                    const editor = await this.breakpointPorts(generation).editor();
                    if (observed?.state === 'idle' && observed.featurePath && sameVanessaFeaturePath(filePath, observed.featurePath) &&
                        observed.lineNumber && !observed.stepStatus && points.includes(observed.lineNumber) && editor && !editor.dirty &&
                        sameVanessaFeaturePath(filePath, editor.featurePath) && editor.lineNumber === observed.lineNumber) {
                        status = 'stopped'; stopLine = observed.lineNumber;
                    }
                }
                let nextLineNumber: number | undefined;
                if (status === 'passed' && mode === 'oneStep' && this.value.capabilities?.editor.supported) {
                    try {
                        const editor = await this.readEditor(generation, source);
                        if (editor && !editor.dirty && sameVanessaFeaturePath(filePath, editor.featurePath)) { nextLineNumber = editor.lineNumber; }
                    } catch { this.checkGeneration(generation); }
                }
                const completed = new Map(this.value.execution?.steps?.map(step => [step.lineNumber, step]));
                if (after && (after.hash !== before?.hash || parsed.kind === 'runResult' && parsed.status === 'passed')) {
                    for (const step of after.steps) { completed.set(step.lineNumber, step); }
                }
                if (mode === 'oneStep') { completed.set(lineNumber, { lineNumber, status }); }
                this.set({ ...this.value, execution: Object.freeze({ ...this.value.execution!, status, steps: Object.freeze([...completed.values()].sort((a, b) => a.lineNumber - b.lineNumber)), ...(nextLineNumber ? { nextLineNumber } : {}),
                    ...(status === 'failed' && this.failureValue ? { currentLineNumber: this.failureValue.lineNumber } : {}),
                    ...(stopLine ? { currentLineNumber: stopLine, stopReason: 'breakpoint' as const } : {}) }) });
                if (stopLine && sourceText !== undefined) {
                    this.resumeSource = { generation, filePath, lineNumber: stopLine, hash: createHash('sha256').update(sourceText).digest('hex') };
                }
                if (stateError || result.isError) {
                    if (status === 'failed') { throw new VanessaConfirmedRunFailureError('The failed execution was confirmed, but a Vanessa MCP request failed.'); }
                    throw new Error('Vanessa reported a tool error.');
                }
            } catch (error) {
                if (!request.confirmedStop || this.value.generation !== generation) { throw error; }
            } finally {
                if (this.runRequest === request) { this.runRequest = undefined; }
            }
        });
    }

    async stop(): Promise<void> {
        this.require('stop');
        const generation = this.value.generation;
        const request = this.runRequest;
        if (request) { request.stopRequested = true; }
        this.set({ ...this.value, status: 'stopping' });
        try { await this.invokeChecked('stop_scenario', {}, generation); }
        catch {
            if (request?.confirmedStop && generation === this.value.generation) { return; }
            if (generation === this.value.generation) {
                this.set({ ...this.value, status: 'unknown', error: 'request',
                    execution: this.value.execution ? Object.freeze({ ...this.value.execution, status: 'unknown' }) : undefined });
            }
            throw new Error('Could not confirm the Vanessa stop request. Refresh state before retrying.');
        }
        // An acknowledgement is not evidence of a paused/stopped executor.
        if (!this.mutation) { await this.refreshState(); }
    }

    /** Undefined desired lines reads only. Selection changes share the mutation lock with runs. */
    async synchronizeBreakpoints(filePath: string, desired?: readonly number[], isCurrent?: () => boolean, sourceText?: string): Promise<readonly number[]> {
        this.validateStep(filePath, 1); this.require('breakpoints'); this.require('editor'); this.require('openFeature');
        if (sourceText !== undefined) { this.require('editorContent'); }
        let confirmed: readonly number[] = [];
        await this.mutate(async generation => {
            const ports = this.breakpointPorts(generation, isCurrent, sourceText === undefined ? undefined : { filePath, text: sourceText });
            ports.assertCurrent();
            let active;
            try { active = await ports.editor(); }
            catch (error) {
                if (!(error instanceof VanessaEditorSourceMismatchError) || sourceText === undefined) { throw error; }
                active = await this.reloadSavedFeature(generation, { filePath, text: sourceText }, isCurrent);
            }
            ports.assertCurrent();
            if (!active || !sameVanessaFeaturePath(filePath, active.featurePath)) { await this.invokeChecked('open_feature_file', { filePath }, generation); }
            ports.assertCurrent();
            const target = { generation, filePath };
            confirmed = await this.breakpointSync.reconcile(target, desired, ports);
            this.breakpointSource = sourceText === undefined ? undefined : { generation, filePath, text: sourceText };
            this.publishBreakpoints(filePath, confirmed, generation);
        });
        return confirmed;
    }

    private async readEditor(generation: number, source?: { filePath: string; text: string }, allowAbsent = false) {
        const parsed = parseVanessaControlReply('get_editor_state', await this.invoke('get_editor_state', { includeContent: !!source }, generation));
        if (allowAbsent && parsed.kind !== 'editor') { return undefined; }
        if (source && (parsed.kind !== 'editor' || sameVanessaFeaturePath(source.filePath, parsed.featurePath) &&
            (parsed.dirty || parsed.content === undefined || !nativeDocumentTextMatchesFileText(source.text.replace(/^\uFEFF/u, ''), parsed.content)))) {
            throw new VanessaEditorSourceMismatchError();
        }
        return parsed.kind === 'editor' ? parsed : undefined;
    }

    /** Explicit execution/breakpoint commands may reload a clean stale copy, never a dirty Vanessa editor. */
    private async reloadSavedFeature(generation: number, source: { filePath: string; text: string }, isCurrent?: () => boolean) {
        const assertCurrent = () => { this.checkGeneration(generation); if (isCurrent && !isCurrent()) { throw new Error('The active feature changed.'); } };
        assertCurrent();
        const active = parseVanessaControlReply('get_editor_state', await this.invoke('get_editor_state', { includeContent: true }, generation));
        const matching = active.kind === 'editor' && sameVanessaFeaturePath(source.filePath, active.featurePath);
        if (matching && (active.dirty || active.content === undefined)) { throw new VanessaEditorSourceMismatchError(); }
        const target = { generation, filePath: source.filePath };
        let points: readonly number[] = [];
        const owned = this.breakpointSync.ownedLines(target);
        if (matching && this.value.capabilities?.breakpoints.supported) {
            const reply = parseVanessaControlReply('manage_breakpoints', await this.invoke('manage_breakpoints', { action: 'list' }, generation));
            if (reply.kind !== 'breakpoints') { throw new VanessaBreakpointUnavailableError(); }
            const after = parseVanessaControlReply('get_editor_state', await this.invoke('get_editor_state', { includeContent: true }, generation));
            if (after.kind !== 'editor' || after.dirty || !sameVanessaFeaturePath(source.filePath, after.featurePath) || after.content !== active.content) {
                throw new VanessaEditorSourceMismatchError();
            }
            points = reply.lines;
        }
        assertCurrent(); await this.invokeChecked('open_feature_file', { filePath: source.filePath }, generation);
        const loaded = await this.readEditor(generation, source);
        if (!loaded || !sameVanessaFeaturePath(source.filePath, loaded.featurePath)) { throw new VanessaEditorSourceMismatchError(); }
        if (points.length) {
            const restored = await this.breakpointSync.restore(target, points, owned, this.breakpointPorts(generation, undefined, source));
            this.publishBreakpoints(source.filePath, restored, generation);
        }
        assertCurrent(); return loaded;
    }

    private breakpointPorts(generation: number, isCurrent?: () => boolean, source?: { filePath: string; text: string }): VanessaBreakpointPorts {
        return {
            assertCurrent: () => {
                this.checkGeneration(generation);
                if (isCurrent && !isCurrent()) { throw new Error('The active feature changed.'); }
            }, editor: () => this.readEditor(generation, source), list: async () => {
                const parsed = parseVanessaControlReply('manage_breakpoints', await this.invoke('manage_breakpoints', { action: 'list' }, generation));
                if (parsed.kind === 'breakpointsUnavailable') { throw new VanessaBreakpointUnavailableError(); }
                if (parsed.kind !== 'breakpoints') { throw new Error('Unknown Vanessa breakpoint response.'); }
                return parsed.lines;
            }, toggle: async line => { await this.invokeChecked('manage_breakpoints', { action: 'toggle', line }, generation); }
        };
    }
    private publishBreakpoints(filePath: string, lines: readonly number[], generation: number): void {
        this.set({ ...this.value, breakpoints: Object.freeze({ filePath, lines,
            ownedLines: Object.freeze(this.breakpointSync.ownedLines({ generation, filePath }).filter(line => lines.includes(line))) }) });
    }

    private async mutate(work: (generation: number) => Promise<void>, invalidateExecutionOnError = true): Promise<void> {
        if (this.mutation || ['running', 'stopping'].includes(this.value.status)) { throw new Error('Vanessa is busy. Stop or wait for the current operation.'); }
        if (this.value.status !== 'ready') { throw new Error('Refresh Vanessa state before executing a command.'); }
        const generation = this.value.generation;
        this.mutation = true;
        try { await work(generation); }
        catch (error) {
            if (generation === this.value.generation && invalidateExecutionOnError && !(error instanceof VanessaConfirmedRunFailureError)) {
                this.set({ ...this.value, status: 'unknown', error: 'request',
                    execution: this.value.execution ? Object.freeze({ ...this.value.execution, status: 'unknown' }) : undefined });
            }
            if (error instanceof VanessaBreakpointUnavailableError || error instanceof VanessaEditorSourceMismatchError || error instanceof VanessaClientControlError || error instanceof VanessaVariableControlError || error instanceof VanessaFormControlError || error instanceof VanessaAuthoringError || error instanceof VanessaDiagnosticError) { throw error; }
            throw new Error('Vanessa command was not confirmed. Refresh state before retrying.');
        } finally {
            if (generation === this.value.generation) {
                this.mutation = false;
                await this.refreshState().catch(() => undefined);
            }
        }
    }

    private require(capability: keyof VanessaControlCapabilities): void {
        if (!this.wire || !this.value.capabilities?.[capability].supported) { throw new Error(`Vanessa MCP capability unavailable: ${capability}.`); }
    }
    private validateStep(filePath: string, lineNumber: number): void {
        if (!filePath.trim() || !Number.isSafeInteger(lineNumber) || lineNumber < 1) { throw new Error('A saved feature and positive line number are required.'); }
    }
    private checkGeneration(generation: number): void {
        if (this.value.generation !== generation) { throw new Error('Vanessa session changed.'); }
    }
    private async invoke(name: string, args: Record<string, unknown>, generation: number, operationSignal?: AbortSignal) {
        this.checkGeneration(generation);
        const signal = operationSignal ? AbortSignal.any([operationSignal, this.lifetime!.signal]) : this.lifetime?.signal;
        const request = Symbol(); this.requests.set(request, name); this.publishRequests();
        try {
        const result = await this.wire!.callTool(name, args, signal,
            ['run_scenario', 'execute_feature_step'].includes(name) ? progress => {
                if (!signal?.aborted && this.value.generation === generation && this.mutation && this.value.execution) {
                    this.set({ ...this.value, execution: Object.freeze({ ...this.value.execution, progress }) });
                }
            } : undefined);
        this.checkGeneration(generation); return result;
        } finally { this.requests.delete(request); if (this.value.generation === generation) { this.publishRequests(); } }
    }
    private publishRequests(): void {
        const tools = [...this.requests.values()];
        const tool = tools.find(value => ['get_form_analysis', 'user_actions_recording', 'execute_feature_step', 'run_scenario'].includes(value)) ?? tools[0];
        this.set({ ...this.value, request: tool ? Object.freeze({ tool, count: tools.length }) : undefined });
    }
    private async invokeChecked(name: string, args: Record<string, unknown>, generation: number): Promise<void> {
        if ((await this.invoke(name, args, generation)).isError) { throw new Error('Vanessa reported a tool error.'); }
    }
    private async readResults(generation: number) {
        try {
            const result = await this.invoke('get_test_results', {}, generation);
            const parsed = parseVanessaControlReply('get_test_results', result);
            const message = parsed.kind === 'failureResult' || parsed.kind === 'runtimeResult' && parsed.status !== 'passed'
                ? /^- Ошибка: ([^\r\n]+)$/mu.exec(result.content?.filter(item => item.type === 'text').map(item => 'text' in item ? item.text : '').join('\n') ?? '')?.[1] : undefined;
            const source = this.executionSource;
            const execution = this.value.execution;
            const steps = source && execution ? mapVanessaStepResults(result, source.text, execution.mode === 'runFeature' ? 1 : execution.lineNumber)
                .filter(step => execution.mode !== 'oneStep' || step.lineNumber === execution.lineNumber) : [];
            return { hash: createHash('sha256').update(JSON.stringify(result)).digest('hex'), parsed, message, steps };
        } catch {
            this.checkGeneration(generation);
            return undefined;
        }
    }
    private set(value: VanessaControlSnapshot): void {
        this.value = Object.freeze(value);
        for (const listener of this.listeners) { listener(this.value); }
    }
}

export { sameVanessaFeaturePath } from './vanessaControlProtocol';
