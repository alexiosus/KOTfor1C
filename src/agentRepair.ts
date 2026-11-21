import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AgentStore, type AgentRecord } from './agentStore';
import { AgentWorkspace, agentHash } from './agentWorkspace';

export interface AgentChange { readonly path: string; readonly expectedSha256: string | null; readonly text: string }
export interface AgentProposedChange { readonly path: string; readonly expectedSha256: string | null; readonly text?: string;
    readonly edits?: readonly { readonly search: string; readonly replace: string; readonly occurrence?: number }[] }
export interface AgentRepairPorts {
    policy(): 'read-only' | 'tests' | 'all';
    classify(file: string): Promise<'test' | 'configuration' | 'unknown'>;
    assertEditable(files: readonly string[]): void;
    changed(files: readonly string[]): Promise<void>;
    busy(): boolean;
    maxAttempts?(): number;
}
const protectedLines = (text: string) => text.split(/\r?\n/u).filter(line =>
    /(?:\b(?:Then|assert|expect|check|verify|skip|ignore|try|except|if|else|endif|do|enddo|while)\b|провер|равн|содерж|ожида|пропуст|попытк|исключен|^\s*(?:Если|Иначе|КонецЕсли|Цикл|КонецЦикла)\b|^\s*@)/iu.test(line)).map(line => line.trim()).join('\n');
function automaticActionEdit(before: string, after: string): boolean {
    const left = before.split(/\r?\n/u); const right = after.split(/\r?\n/u);
    if (left.length !== right.length || protectedLines(before) !== protectedLines(after)) { return false; }
    const changed = left.flatMap((line, index) => line === right[index] ? [] : [{ before: line, after: right[index] }]);
    return changed.length > 0 && changed.length <= 3 && changed.every(change => [change.before, change.after].every(line =>
        /^\s*(?:Given|When|And|Допустим|Дано|Когда|И)\s+/iu.test(line) && /(?:\b(?:click|open|close|fill|select|press|wait)\b|нажима|открыва|закрыва|ввожу|выбира|ожидаю)/iu.test(line)));
}

export class AgentRepairs {
    private applying = false;
    constructor(private readonly store: AgentStore, private readonly workspace: AgentWorkspace, private readonly ports: AgentRepairPorts) {}
    async propose(input: { changes: readonly AgentProposedChange[]; reason: string; evidence: readonly string[]; operationId?: string }) {
        if (!input.changes.length || input.changes.length > 20 || input.reason.trim().length < 20 || !input.evidence.length) {
            throw new Error('A repair needs 1–20 changes, an explanation and evidence references.');
        }
        if (input.operationId) { await this.store.get(input.operationId); }
        if (input.operationId && (await this.store.list(100_000)).filter(record => record.kind === 'repair'
            && record.request.operationId === input.operationId && record.status === 'completed').length >= (this.ports.maxAttempts?.() ?? 3)) {
            throw new Error('The repair attempt limit for this operation is reached. Record the remaining findings and ask for a decision.');
        }
        const changes: AgentChange[] = []; const risks: string[] = []; const seen = new Set<string>();
        for (const proposed of input.changes) {
            if ((proposed.text === undefined) === (proposed.edits === undefined)) { throw new Error('Provide either complete text or localized edits.'); }
            const file = await this.workspace.resolve(proposed.path, proposed.expectedSha256 === null);
            if (seen.has(file.toLowerCase())) { throw new Error('Duplicate repair path.'); } seen.add(file.toLowerCase());
            if (proposed.text !== undefined && (Buffer.byteLength(proposed.text) > 1024 * 1024 || proposed.text.includes('\u0000'))) { throw new Error('Repair source exceeds the text limit. Use localized edits for long sources.'); }
            const category = await this.ports.classify(file);
            if (category === 'unknown') { throw new Error('Repair path is outside configured test and configuration source roots.'); }
            let before = '';
            try {
                before = await fs.readFile(file, 'utf8');
                if (proposed.expectedSha256 === null || agentHash(before) !== proposed.expectedSha256) { throw new Error('Repair base revision does not match.'); }
            } catch (error) { if (proposed.expectedSha256 !== null || (error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
            let text = proposed.text ?? before;
            if (proposed.edits) {
                if (proposed.expectedSha256 === null || !proposed.edits.length || proposed.edits.length > 20) { throw new Error('Localized edits require an existing source and 1–20 edits.'); }
                const eol = before.includes('\r\n') ? '\r\n' : '\n';
                for (const edit of proposed.edits) {
                    if (!edit.search || edit.search.includes('\u0000') || edit.replace.includes('\u0000')) { throw new Error('Invalid localized edit.'); }
                    const search = edit.search.replace(/\r?\n/gu, eol); const replacement = edit.replace.replace(/\r?\n/gu, eol);
                    const matches: number[] = []; let index = text.indexOf(search);
                    while (index >= 0 && matches.length <= 10000) { matches.push(index); index = text.indexOf(search, index + search.length); }
                    const selected = matches.length === 1 ? matches[0] : edit.occurrence === undefined ? undefined : matches[edit.occurrence];
                    if (selected === undefined) { throw new Error('Localized edit is missing or ambiguous. Choose an exact search and occurrence.'); }
                    text = text.slice(0, selected) + replacement + text.slice(selected + search.length);
                }
            }
            const change: AgentChange = { path: file, expectedSha256: proposed.expectedSha256, text };
            if (category === 'configuration') { risks.push('configuration'); }
            if (category === 'test' && change.expectedSha256 !== null && (!automaticActionEdit(before, change.text) || /\.(?:bsl|os|xml)$/iu.test(file))) { risks.push('test_behavior'); }
            changes.push(change);
        }
        this.ports.assertEditable(changes.map(change => change.path));
        const { record } = await this.store.create('repair', { changes, reason: input.reason, evidence: input.evidence,
            operationId: input.operationId, risks: [...new Set(risks)] });
        const policy = this.ports.policy();
        const approvalRequired = policy === 'read-only' || risks.includes('test_behavior') || risks.includes('configuration') && policy !== 'all';
        for (let index = 0; index < changes.length; index++) {
            const change = changes[index];
            await this.store.artifact(record.id, `before-${index}-${path.basename(change.path)}`, change.expectedSha256 === null ? '' : await fs.readFile(change.path, 'utf8'));
            await this.store.artifact(record.id, `after-${index}-${path.basename(change.path)}`, change.text);
        }
        await this.store.update(record.id, value => { value.status = approvalRequired ? 'awaiting_approval' : 'awaiting_agent'; });
        return this.store.get(record.id);
    }
    async approve(id: string, approved: boolean): Promise<AgentRecord> {
        const record = await this.store.get(id);
        if (record.kind !== 'repair' || record.status !== 'awaiting_approval') { throw new Error('This repair is not awaiting a user decision.'); }
        return this.store.update(id, value => {
            value.status = approved ? 'awaiting_agent' : 'cancelled';
            value.events.push({ time: new Date().toISOString(), kind: 'user_decision', data: { approved } });
        });
    }
    async apply(id: string): Promise<AgentRecord> {
        if (this.applying || this.ports.busy()) { throw new Error('Wait for the active operation before applying changes.'); }
        this.applying = true;
        try {
            const record = await this.store.get(id);
            if (record.kind !== 'repair' || record.status !== 'awaiting_agent') { throw new Error('This repair is not ready or requires approval.'); }
            const changes = record.request.changes as AgentChange[];
            const approved = record.events.some(event => event.kind === 'user_decision' && (event.data as { approved: boolean }).approved);
            if (this.ports.policy() === 'read-only' && !approved || record.request.risks && (record.request.risks as string[]).includes('configuration') && this.ports.policy() !== 'all' && !approved) {
                throw new Error('The current policy requires a user decision.');
            }
            this.ports.assertEditable(changes.map(change => change.path));
            const prepared: Array<{ change: AgentChange; before: string | null }> = [];
            const check = async (change: AgentChange) => {
                const resolved = await this.workspace.resolve(change.path, change.expectedSha256 === null);
                if (resolved !== change.path) { throw new Error('Repair destination changed.'); }
                let before: string | null = null;
                try { before = await fs.readFile(resolved, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') { throw error; } }
                if ((before === null ? null : agentHash(before)) !== change.expectedSha256) { throw new Error('Source changed since this repair was proposed.'); }
                return before;
            };
            for (const change of changes) { prepared.push({ change, before: await check(change) }); }
            const applied: typeof prepared = [];
            try {
                for (const item of prepared) {
                    await check(item.change); this.ports.assertEditable([item.change.path]);
                    await fs.mkdir(path.dirname(item.change.path), { recursive: true }); await check(item.change);
                    const temporary = item.change.path + '.' + randomUUID() + '.tmp';
                    try { await fs.writeFile(temporary, item.change.text, { flag: 'wx' }); await check(item.change); await fs.rename(temporary, item.change.path); }
                    finally { await fs.unlink(temporary).catch(() => undefined); }
                    applied.push(item);
                }
            } catch (error) {
                for (const item of applied.reverse()) {
                    if (agentHash(await fs.readFile(item.change.path, 'utf8')) !== agentHash(item.change.text)) { continue; }
                    if (item.before === null) { await fs.unlink(item.change.path); } else { await fs.writeFile(item.change.path, item.before); }
                }
                throw error;
            }
            await this.store.update(id, value => { value.status = 'completed'; value.result = { applied: changes.map(change => ({ path: change.path,
                before: change.expectedSha256, after: agentHash(change.text) })), verified: false }; });
            await this.ports.changed(changes.map(change => change.path));
            return this.store.get(id);
        } finally { this.applying = false; }
    }
}
