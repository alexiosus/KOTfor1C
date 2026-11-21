import { AgentStore, type AgentStatus } from './agentStore';
import type { AgentConfigurationDeployment } from './agentInfobases';

export interface AgentTest { readonly id: string; readonly name: string; readonly source: string; readonly script?: string; readonly group?: string; readonly dependencies?: readonly string[] }
export interface AgentTestResult { readonly status: 'passed' | 'failed' | 'stopped' | 'cancelled' | 'unknown'; readonly details?: unknown }
export interface AgentExecutionPorts {
    prepare?(tests: readonly AgentTest[], context: AgentRunContext): Promise<void>;
    tests(): Promise<readonly AgentTest[]>;
    run(test: AgentTest, signal: AbortSignal, event: (kind: string, data: unknown) => Promise<void>, context: AgentRunContext): Promise<AgentTestResult>;
    cancel(): Promise<void>;
    evidence(): Promise<unknown>;
    revision(): Promise<unknown>;
}
export interface AgentRunContext { readonly mode?: 'full' | 'step' | 'fromLine'; readonly line?: number; readonly environment?: string;
    readonly environmentId?: string; readonly configurationDeployment?: AgentConfigurationDeployment;
    readonly probeSource?: string; readonly occurrence?: number; readonly preconditions?: string; readonly baselineRestored?: boolean }
export interface AgentRunRequest extends AgentRunContext { readonly tests: readonly string[]; readonly stopOnFailure: boolean; readonly requestKey: string }

/** The external agent reasons about failures; this executor owns ordering and facts. */
export class AgentExecution {
    private active?: { id: string; controller: AbortController; done: Promise<void> };
    constructor(readonly store: AgentStore, private readonly ports: AgentExecutionPorts) {}
    async start(request: AgentRunRequest) {
        const catalog = await this.ports.tests();
        if (!request.tests.length || request.tests.length > 200 || new Set(request.tests).size !== request.tests.length) { throw new Error('Choose 1–200 unique tests.'); }
        const tests = request.tests.map(id => {
            const matches = catalog.filter(test => test.id === id);
            if (matches.length !== 1) { throw new Error('A selected test is missing or ambiguous. Refresh the catalog.'); }
            return matches[0];
        });
        if (request.mode && request.mode !== 'full' && (tests.length !== 1 || !request.line)) { throw new Error('A probe needs one test and an explicit source line.'); }
        const context = { mode: request.mode ?? 'full', ...(request.line ? { line: request.line } : {}), ...(request.environment ? { environment: request.environment } : {}),
            ...(request.environmentId ? { environmentId: request.environmentId } : {}), ...(request.configurationDeployment ? { configurationDeployment: request.configurationDeployment } : {}),
            ...(request.probeSource ? { probeSource: request.probeSource } : {}), ...(request.occurrence !== undefined ? { occurrence: request.occurrence } : {}),
            ...(request.preconditions ? { preconditions: request.preconditions } : {}), ...(request.baselineRestored !== undefined ? { baselineRestored: request.baselineRestored } : {}) };
        const created = await this.store.create('run', { tests: tests.map(test => ({ ...test })), stopOnFailure: request.stopOnFailure, ...context }, request.requestKey);
        if (created.existing) { return created.record; }
        if (this.active) {
            await this.store.update(created.record.id, record => { record.status = 'cancelled'; record.result = { reason: 'executor_busy' }; });
            throw new Error('Another agent run owns the test client.');
        }
        const controller = new AbortController();
        const active = { id: created.record.id, controller, done: Promise.resolve() };
        this.active = active;
        active.done = this.execute(created.record.id, tests, request.stopOnFailure, controller.signal, context).finally(() => { if (this.active === active) { this.active = undefined; } });
        void active.done.catch(() => undefined);
        return { ...created.record, status: 'running' as const };
    }
    private async execute(id: string, tests: readonly AgentTest[], stopOnFailure: boolean, signal: AbortSignal, context: AgentRunContext): Promise<void> {
        let status: AgentStatus = 'passed'; const results: Array<{ test: string; result: AgentTestResult }> = [];
        try {
            await this.store.update(id, record => { record.status = 'running'; });
            await this.store.artifact(id, 'source-revision.json', JSON.stringify(await this.ports.revision(), null, 2));
            if (signal.aborted) { await this.store.update(id, record => { record.status = 'cancelled'; }); return; }
            await this.ports.prepare?.(tests, context);
            for (const test of tests) {
                if (signal.aborted) { status = 'cancelled'; break; }
                await this.store.event(id, 'test_started', test);
                const result = await this.ports.run(test, signal, async (kind, data) => {
                    if (kind === 'source_snapshot') {
                        const artifact = await this.store.artifact(id, 'execution-sources.json', JSON.stringify(data, null, 2));
                        await this.store.event(id, 'source_snapshot', { artifactId: artifact.id });
                    } else { await this.store.event(id, kind, data); }
                }, context);
                if (result.details !== undefined) { await this.store.artifact(id, 'test-result-' + test.id.slice(0, 16) + '.json', JSON.stringify(result, null, 2)); }
                results.push({ test: test.id, result });
                await this.store.event(id, 'test_finished', { test: test.id, result });
                if (result.status !== 'passed') {
                    status = result.status;
                    try { await this.store.artifact(id, 'failure-evidence.json', JSON.stringify(await this.ports.evidence(), null, 2)); }
                    catch (error) { await this.store.event(id, 'evidence_unavailable', { message: error instanceof Error ? error.message : 'Unavailable' }); }
                    if (stopOnFailure || result.status !== 'failed') { break; }
                }
            }
            if (signal.aborted && status === 'passed') { status = 'cancelled'; }
            await this.store.update(id, record => { record.status = status; record.result = { results, planned: tests.length,
                executed: results.length, remaining: tests.slice(results.length).map(test => test.id), complete: results.length === tests.length, fullVerification: context.mode === 'full', baselineRestored: !!context.baselineRestored,
                next: status === 'failed' ? 'Investigate the evidence, propose a repair and verify it in a new run.' : undefined }; });
        } catch (error) {
            try { await this.store.artifact(id, 'failure-evidence.json', JSON.stringify(await this.ports.evidence(), null, 2)); }
            catch { await this.store.event(id, 'evidence_unavailable', { reason: 'The operation or session could not be inspected.' }); }
            await this.store.update(id, record => { record.status = 'unknown';
                record.result = { results, planned: tests.length, executed: results.length, remaining: tests.slice(results.length).map(test => test.id),
                    fullVerification: context.mode === 'full', baselineRestored: !!context.baselineRestored,
                    error: error instanceof Error ? error.message : 'Execution failed', complete: false }; });
        }
    }
    async cancel(id: string) {
        if (this.active?.id !== id) { throw new Error('This operation does not own the active test client.'); }
        this.active.controller.abort();
        await this.store.event(id, 'stop_requested', { confirmed: false });
        try { await this.ports.cancel(); } catch { await this.store.event(id, 'stop_unconfirmed', { reconcile: true }); }
        return this.store.get(id);
    }
    async idle(): Promise<void> { await this.active?.done; await this.store.idle(); }
    async dispose(): Promise<void> { if (this.active) { await this.cancel(this.active.id).catch(() => undefined); } await this.idle(); }
    get busy(): boolean { return !!this.active; }
}
