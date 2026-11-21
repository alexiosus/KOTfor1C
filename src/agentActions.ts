import { randomUUID } from 'node:crypto';
import { AgentStore } from './agentStore';
import { agentHash } from './agentWorkspace';
import { validateAgentArguments } from './agentTools';
import { withKotInteraction, type KotAnswer, type KotQuestion, type KotInteraction } from './kotInteraction';
import { redactVanessaDiagnosticText } from './vanessaControlRedaction';

export interface AgentAction {
    id: string; domain: string; description: string; inputSchema: Record<string, unknown>; mutates: boolean; execution?: boolean; destructive?: boolean; interrupts?: boolean;
}
export interface AgentActionPorts {
    list(): readonly AgentAction[];
    invoke(action: string, input: Record<string, unknown>): Promise<unknown>;
    resolvePath(path: string, create: boolean): Promise<unknown>;
    allowed?(action: AgentAction): void;
    token(signal: AbortSignal): unknown;
}
interface PendingQuestion {
    id: string; question: KotQuestion; validate?: (answer: KotAnswer) => Promise<void>;
    resolve(answer: KotAnswer): void; reject(error: Error): void; answering: boolean; done: Promise<void>;
}
interface ActiveAction { id: string; action: AgentAction; abort: AbortController; question?: PendingQuestion; done: Promise<void>; clean?(value: unknown): unknown }

/** Runs existing KOT operations once, while their native prompts become observable API questions. */
export class AgentActions {
    private active?: ActiveAction;
    private closed = false;
    constructor(private readonly store: AgentStore, private readonly ports: AgentActionPorts) {}
    get busy(): boolean { return !!this.active; }
    list(domain?: string) { return this.ports.list().filter(action => !domain || action.domain === domain); }
    async start(actionId: string, input: Record<string, unknown>, requestKey: string) {
        if (this.closed) { throw new Error('KOT actions are stopping.'); }
        const action = this.ports.list().find(item => item.id === actionId);
        if (!action) { throw new Error('Unknown action. Read kot_actions.'); }
        validateAgentArguments(action.inputSchema, input); this.ports.allowed?.(action);
        const created = await this.store.create('incident', { action: 'kot_action', actionId, inputHash: agentHash(JSON.stringify(input)) }, 'action:' + requestKey);
        if (created.existing) { return { id: created.record.id, status: created.record.status }; }
        if (this.active) { await this.store.update(created.record.id, value => { value.status = 'cancelled'; }); throw new Error('Finish or cancel the active KOT action.'); }
        const active: ActiveAction = { id: created.record.id, action, abort: new AbortController(), done: Promise.resolve() }; this.active = active;
        active.done = this.run(active, action, input); void active.done.catch(() => undefined);
        return { id: active.id, status: 'running' };
    }
    private async run(active: ActiveAction, action: AgentAction, input: Record<string, unknown>) {
        let errorNotification = false; const notices: Array<{ level: string; message: string }> = []; let writes = Promise.resolve();
        const secrets = new Set<string>();
        const secretField = (key: string) => /(?:^|[._ -])(?:password|pwd|пароль|token|api[_ -]?key|authorization|secret)$/iu.test(key);
        const collect = (value: unknown): void => {
            if (!value || typeof value !== 'object') { return; }
            const record = value as Record<string, unknown>;
            for (const [key, field] of Object.entries(record)) {
                if (typeof field === 'string' && field && (secretField(key) || key === 'value' && typeof record.key === 'string' && secretField(record.key))) { secrets.add(field); }
                else { collect(field); }
            }
        };
        collect(input);
        const clean = (value: unknown): unknown => {
            if (typeof value === 'string') { let result = redactVanessaDiagnosticText(value); for (const secret of secrets) { result = result.split(secret).join('[redacted]'); } return result; }
            if (Array.isArray(value)) { return value.map(clean); }
            if (value && typeof value === 'object') {
                const record = value as Record<string, unknown>;
                const namedSecret = record.secret === true || [record.key, record.field].some(key => typeof key === 'string' && secretField(key));
                return Object.fromEntries(Object.entries(record).map(([key, field]) => {
                    const settingRevision = key === 'token' && typeof record.key === 'string' && record.key.startsWith('kotTestToolkit.') && typeof record.configured === 'boolean';
                    if (typeof field === 'string' && (['id', 'kind', 'type', 'status', 'domain', 'actionId', 'revision', 'expectedRevision', 'key', 'field', 'command', 'section'].includes(key) || settingRevision)) { return [key, field]; }
                    return [key, typeof field === 'string' && (secretField(key) || namedSecret && key === 'value') ? '[redacted]' : clean(field)];
                }));
            }
            return value;
        };
        active.clean = clean;
        const event = (kind: string, data: unknown) => { writes = writes.then(() => this.store.event(active.id, kind, data)); void writes.catch(() => undefined); };
        const host: KotInteraction = {
            token: undefined, resolvePath: this.ports.resolvePath,
            notify: (level, message) => {
                if (level === 'error') { errorNotification = true; }
                const value = { level, message: clean(message) as string }; if (notices.length < 100) { notices.push(value); }
                event('action_notification', value);
            },
            progress: value => event('action_progress', clean(value)),
            ask: async (question, validate) => {
                if (active.abort.signal.aborted) { throw new Error('The KOT action was cancelled.'); }
                if (active.question) { throw new Error('The native action requested overlapping questions.'); }
                let pending!: PendingQuestion;
                const answer = new Promise<KotAnswer>((resolve, reject) => { pending = { id: randomUUID(), question, validate, resolve, reject, answering: false, done: Promise.resolve() }; });
                pending.done = answer.then(() => undefined, () => undefined);
                if (question.password) {
                    const nativeResolve = pending.resolve;
                    pending.resolve = value => { if (value.text) { secrets.add(value.text); } nativeResolve(value); };
                }
                active.question = pending;
                try {
                    await writes;
                    await this.store.event(active.id, 'action_question', clean({ id: pending.id, kind: question.kind, title: question.title, message: question.message, totalOptions: question.options?.length }));
                    await this.store.update(active.id, value => { value.status = 'awaiting_agent'; });
                    return await answer;
                } finally { pending.resolve({ cancel: true }); if (active.question === pending) { active.question = undefined; } }
            }
        };
        try {
            host.token = this.ports.token(active.abort.signal); this.ports.allowed?.(action);
            await this.store.update(active.id, value => { value.status = 'running'; });
            let result = clean(await withKotInteraction(host, () => this.ports.invoke(action.id, input)));
            while (active.question) { await active.question.done; await Promise.resolve(); }
            await writes;
            const json = JSON.stringify(result ?? null);
            if (json.length > 64000) { const artifact = await this.store.artifact(active.id, 'action-result.json', json); result = { artifactId: artifact.id, size: artifact.size }; }
            await this.store.update(active.id, value => { value.status = active.abort.signal.aborted ? 'cancelled' : errorNotification ? 'failed' : 'completed';
                value.result = { actionId: action.id, result: result ?? null, notifications: notices }; });
        } catch (error) {
            await writes.catch(() => undefined);
            await this.store.update(active.id, value => { value.status = active.abort.signal.aborted ? 'cancelled' : 'failed';
                value.result = { actionId: action.id, error: clean(error instanceof Error ? error.message : 'Action failed'), notifications: notices }; });
        } finally { if (this.active === active) { this.active = undefined; } }
    }
    question(operationId: string, offset = 0, limit = 50) {
        const active = this.active;
        if (active?.id !== operationId || !active.question) { throw new Error('No live question for this operation. Read kot_operation.'); }
        const { id, question } = active.question; const { options, ...fields } = question;
        const visible = active.clean!({ ...fields, options: options?.slice(offset, offset + limit) }) as Record<string, unknown>;
        return { id, ...visible, totalOptions: options?.length ?? 0,
            nextOffset: options && offset + limit < options.length ? offset + limit : undefined };
    }
    async answer(operationId: string, questionId: string, answer: KotAnswer, requestKey: string) {
        const previous = await this.store.create('incident', { action: 'kot_action_answer', operationId, questionId, answerHash: agentHash(JSON.stringify(answer)) }, 'action-answer:' + requestKey);
        if (previous.existing) { return { id: operationId, status: previous.record.status }; }
        try {
            const active = this.active; const pending = active?.question;
            if (active?.id !== operationId || pending?.id !== questionId || pending.answering) { throw new Error('Question changed or is already being answered. Read the current question.'); }
            if (!answer.cancel) { this.ports.allowed?.(active.action); }
            pending.answering = true;
            try { if (!answer.cancel) { await pending.validate?.(answer); } }
            catch (error) { pending.answering = false; throw error; }
            if (active.abort.signal.aborted || active.question !== pending) { throw new Error('The question was cancelled while validating. Inspect kot_operation.'); }
            await this.store.update(previous.record.id, value => { value.status = 'completed'; });
            await this.store.update(active.id, value => { value.status = 'running'; });
            if (answer.cancel) { active.abort.abort(); }
            pending.resolve(answer);
            return { id: operationId, status: 'running' };
        } catch (error) { const pending = this.active?.question; if (pending?.id === questionId) { pending.answering = false; }
            await this.store.update(previous.record.id, value => { value.status = 'failed'; }); throw error; }
    }
    async cancel(operationId: string) {
        const active = this.active;
        if (active?.id !== operationId) {
            const record = await this.store.get(operationId);
            if (record.request.action === 'kot_action' && ['cancelled', 'failed', 'completed', 'unknown'].includes(record.status)) { return { id: operationId, status: record.status }; }
            throw new Error('No active KOT action with this ID. Inspect kot_operation.');
        }
        await this.store.event(operationId, 'action_cancellation_requested', {});
        active.abort.abort(); active.question?.resolve({ cancel: true });
        return { id: operationId, cancellationRequested: true, status: 'running' };
    }
    async dispose() {
        this.closed = true; const active = this.active;
        if (!active) { return; }
        active.abort.abort(); active.question?.reject(new Error('The extension stopped. Inspect the operation before retrying.')); await active.done;
    }
}
